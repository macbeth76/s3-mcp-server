#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";

const S3_REGION = process.env.S3_REGION || "auto";
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;

if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
  console.error("Error: S3_ENDPOINT, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables are required.");
  process.exit(1);
}

const s3Client = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
  // Required for any non-AWS S3-compatible endpoint (SeaweedFS, MinIO,
  // Cloudflare R2, etc.) — without this the SDK defaults to
  // virtual-hosted-style addressing (http://<bucket>.<endpoint>/<key>).
  // Against a plain host:port endpoint with no wildcard DNS, that silently
  // does NOT error: the request still goes out, but the server parses the
  // request path's first segment as the bucket name instead of the Host
  // header, so every operation naming a bucket writes/reads/deletes at the
  // wrong location. Confirmed live against SeaweedFS: a
  // put_object(bucket="mesh-backups", key="vet-test/probe.txt") silently
  // created a *new* bucket literally named "vet-test" containing
  // "probe.txt", while reporting success and never touching mesh-backups
  // at all. forcePathStyle makes the SDK send bucket+key both in the
  // path (http://<endpoint>/<bucket>/<key>), which every S3-compatible
  // server (including real AWS) understands unambiguously.
  forcePathStyle: true,
});

const server = new Server(
  {
    name: "s3-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to convert stream to string
const streamToString = (stream: any): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on("data", (chunk: any) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "s3_list_buckets",
        description: "List all S3 buckets",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "s3_list_objects",
        description: "List objects in an S3 bucket",
        inputSchema: {
          type: "object",
          properties: {
            bucket: {
              type: "string",
              description: "The name of the bucket",
            },
            prefix: {
              type: "string",
              description: "Optional prefix to filter objects",
            },
            maxKeys: {
              type: "number",
              description: "Maximum number of keys to return (default 1000)",
            },
          },
          required: ["bucket"],
        },
      },
      {
        name: "s3_read_object",
        description: "Read the content of an object from an S3 bucket",
        inputSchema: {
          type: "object",
          properties: {
            bucket: {
              type: "string",
              description: "The name of the bucket",
            },
            key: {
              type: "string",
              description: "The key (path) of the object",
            },
          },
          required: ["bucket", "key"],
        },
      },
      {
        name: "s3_put_object",
        description: "Upload an object to an S3 bucket",
        inputSchema: {
          type: "object",
          properties: {
            bucket: {
              type: "string",
              description: "The name of the bucket",
            },
            key: {
              type: "string",
              description: "The key (path) of the object",
            },
            content: {
              type: "string",
              description: "The content to upload",
            },
          },
          required: ["bucket", "key", "content"],
        },
      },
      {
        name: "s3_delete_object",
        description: "Delete an object from an S3 bucket",
        inputSchema: {
          type: "object",
          properties: {
            bucket: {
              type: "string",
              description: "The name of the bucket",
            },
            key: {
              type: "string",
              description: "The key (path) of the object",
            },
          },
          required: ["bucket", "key"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "s3_list_buckets": {
        const command = new ListBucketsCommand({});
        const response = await s3Client.send(command);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.Buckets || [], null, 2),
            },
          ],
        };
      }

      case "s3_list_objects": {
        const { bucket, prefix, maxKeys } = request.params.arguments as {
          bucket: string;
          prefix?: string;
          maxKeys?: number;
        };
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: maxKeys,
        });
        const response = await s3Client.send(command);
        const files = (response.Contents || []).map((item) => ({
          key: item.Key,
          size: item.Size,
          lastModified: item.LastModified,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(files, null, 2),
            },
          ],
        };
      }

      case "s3_read_object": {
        const { bucket, key } = request.params.arguments as {
          bucket: string;
          key: string;
        };
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        const response = await s3Client.send(command);
        const body = await streamToString(response.Body);
        return {
          content: [
            {
              type: "text",
              text: body,
            },
          ],
        };
      }

      case "s3_put_object": {
        const { bucket, key, content } = request.params.arguments as {
          bucket: string;
          key: string;
          content: string;
        };
        const command = new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: content,
        });
        await s3Client.send(command);
        return {
          content: [
            {
              type: "text",
              text: `Successfully uploaded to ${bucket}/${key}`,
            },
          ],
        };
      }

      case "s3_delete_object": {
        const { bucket, key } = request.params.arguments as {
          bucket: string;
          key: string;
        };
        const command = new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        await s3Client.send(command);
        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted ${bucket}/${key}`,
            },
          ],
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

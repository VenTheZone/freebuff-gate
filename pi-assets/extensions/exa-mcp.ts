/**
 * Exa MCP extension for Pi
 *
 * Pi has no native MCP support, so this extension bridges the Exa MCP server
 * (https://mcp.exa.ai/mcp) to Pi. On session start it performs the MCP
 * `initialize` handshake (the server uses streamable HTTP and returns an
 * `Mcp-Session-Id` that must be replayed on every subsequent request), lists
 * the available tools, and registers each one as a Pi tool. Tool calls are
 * forwarded to the MCP server via `tools/call`.
 *
 * Install: drop this file in ~/.pi/agent/extensions/ (auto-discovered).
 * Config (optional): set EXA_API_KEY in the environment if Exa requires auth
 * for your account. The server also works without a key.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const PROTOCOL_VERSION = "2025-06-18";

// ---- Minimal MCP streamable-HTTP client -------------------------------------

interface McmSession {
	sessionId: string | null;
}

let activeCallId = 1;

function authHeaders(): Record<string, string> {
	const key = process.env.EXA_API_KEY?.trim();
	if (key) {
		return { "x-api-key": key, Authorization: `Bearer ${key}` };
	}
	return {};
}

async function mcpPost(
	session: McmSession,
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<any> {
	const id = activeCallId++;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...authHeaders(),
	};
	if (session.sessionId) {
		headers["Mcp-Session-Id"] = session.sessionId;
	}

	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		signal,
	});

	if (!session.sessionId) {
		const sid = response.headers.get("mcp-session-id");
		if (sid) session.sessionId = sid;
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Exa MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
	}

	const body = await response.text();
	return parseJsonRpc(body, id);
}

/** Parse a (possibly SSE) JSON-RPC response body and return the matching result. */
function parseJsonRpc(body: string, id: number): any {
	const candidates: any[] = [];

	// SSE framing: lines starting with "data:".
	if (body.includes("data:")) {
		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload) continue;
			try {
				const obj = JSON.parse(payload);
				if (obj && (obj.result !== undefined || obj.error !== undefined)) {
					candidates.push(obj);
				}
			} catch {
				/* ignore non-JSON lines */
			}
		}
	} else {
		try {
			const obj = JSON.parse(body);
			if (obj && (obj.result !== undefined || obj.error !== undefined)) {
				candidates.push(obj);
			}
		} catch {
			/* ignore */
		}
	}

	const match = candidates.find((c) => c.id === id) ?? candidates[0];
	if (!match) {
		throw new Error("Exa MCP returned an empty response");
	}
	if (match.error) {
		const code = typeof match.error.code === "number" ? ` ${match.error.code}` : "";
		throw new Error(`Exa MCP error${code}: ${match.error.message || "unknown error"}`);
	}
	return match.result;
}

// ---- JSON Schema (MCP) -> TypeBox (Pi) --------------------------------------

function convertSchema(schema: any): TSchema {
	if (!schema || typeof schema !== "object") return Type.Any();
	switch (schema.type) {
		case "object": {
			const props: Record<string, TSchema> = {};
			const required: string[] = Array.isArray(schema.required) ? schema.required : [];
			const properties = schema.properties ?? {};
			for (const [key, raw] of Object.entries<any>(properties)) {
				props[key] = withDescription(convertSchema(raw), raw?.description);
			}
			const opts: Record<string, unknown> = {
				additionalProperties: schema.additionalProperties === true,
			};
			if (required.length) opts.optional = false;
			return Type.Object(props, opts) as TSchema;
		}
		case "array": {
			const items = schema.items ? convertSchema(schema.items) : Type.Any();
			const opts: Record<string, unknown> = {};
			if (typeof schema.minItems === "number") opts.minItems = schema.minItems;
			if (typeof schema.maxItems === "number") opts.maxItems = schema.maxItems;
			return Type.Array(items, opts) as TSchema;
		}
		case "number":
		case "integer": {
			const opts: Record<string, unknown> = {};
			if (typeof schema.minimum === "number") opts.minimum = schema.minimum;
			if (typeof schema.maximum === "number") opts.maximum = schema.maximum;
			return Type.Number(opts) as TSchema;
		}
		case "boolean":
			return Type.Boolean() as TSchema;
		case "string": {
			const opts: Record<string, unknown> = {};
			if (typeof schema.minLength === "number") opts.minLength = schema.minLength;
			if (typeof schema.maxLength === "number") opts.maxLength = schema.maxLength;
			if (Array.isArray(schema.enum)) opts.enum = schema.enum;
			return withDescription(Type.String(opts) as TSchema, schema.description);
		}
		default:
			return Type.Any() as TSchema;
	}
}

function withDescription(schema: TSchema, description?: string): TSchema {
	if (description && typeof description === "string") {
		(schema as any).description = description;
	}
	return schema;
}

// ---- Extension --------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Connect to Exa MCP lazily on session start so we don't open network
	// connections in invocations that never start a session.
	pi.on("session_start", async (_event, ctx) => {
		const session: McmSession = { sessionId: null };

		try {
			await mcpPost(
				session,
				"initialize",
				{
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "pi-exa-mcp", version: "1.0.0" },
				},
				ctx.signal,
			);

			const listResult = await mcpPost(session, "tools/list", {}, ctx.signal);
			const tools: any[] = listResult?.tools ?? [];

			if (tools.length === 0) {
				ctx.ui.notify("Exa MCP: no tools returned", "warning");
				return;
			}

			for (const tool of tools) {
				const parameters = convertSchema(tool.inputSchema ?? { type: "object" });
				pi.registerTool({
					name: tool.name,
					label: tool.name,
					description: tool.description ?? `Exa MCP tool ${tool.name}`,
					promptSnippet: `Use ${tool.name} (Exa web tools)`,
					parameters,
					async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
						const result = await mcpPost(
							session,
							"tools/call",
							{ name: tool.name, arguments: params ?? {} },
							signal,
						);

						const content = Array.isArray(result?.content)
							? result.content
							: [];
						const text = content
							.map((c: any) => (c?.type === "text" ? c.text : ""))
							.filter((t: string) => typeof t === "string" && t.length > 0)
							.join("\n\n");

						if (result?.isError) {
							return {
								content: [
									{
										type: "text",
										text: text || "Exa MCP tool returned an error.",
									},
								],
								details: { error: true },
								isError: true,
							};
						}

						return {
							content: [{ type: "text", text: text || "(no content returned)" }],
							details: {},
						};
					},
				});
			}

			ctx.ui.notify(
				`Exa MCP connected: ${tools.map((t) => t.name).join(", ")}`,
				"info",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Exa MCP failed to connect: ${message}`, "error");
		}
	});
}

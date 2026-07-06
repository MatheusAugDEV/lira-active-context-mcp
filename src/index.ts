import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const REPO_OWNER = "MatheusAugDEV";
const REPO_NAME = "lira-active-context";
const REPO_BRANCH = "main";
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 250;

const TOOL_DEFINITIONS = [
	{
		name: "get_lira_state",
		path: "LIRA_STATE.json",
		description: "Lê o estado canônico da Lira do repo lira-active-context",
		kind: "json",
	},
	{
		name: "get_lira_boot",
		path: "LIRA_BOOT.md",
		description: "Lê o boot canônico da Lira do repo lira-active-context",
		kind: "markdown",
	},
	{
		name: "get_lira_roadmap",
		path: "ROADMAP.md",
		description: "Lê o roadmap canônico da Lira do repo lira-active-context",
		kind: "markdown",
	},
	{
		name: "get_lira_decision_locks",
		path: "DECISION_LOCKS.md",
		description: "Lê os decision locks canônicos da Lira do repo lira-active-context",
		kind: "markdown",
	},
] as const;

type ToolDefinition = (typeof TOOL_DEFINITIONS)[number];
type ToolKind = ToolDefinition["kind"];
type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTokenPreview(token: string | undefined): string {
	if (!token) {
		return "<missing>";
	}

	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function createJsonError(message: string): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

class GitHubContentClient {
	constructor(private readonly env: Env) {}

	private get githubPat(): string | undefined {
		return (this.env as any).GITHUB_PAT as string | undefined;
	}

	async readRaw(path: string): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
		const token = this.githubPat;

		if (!token) {
			return {
				ok: false,
				status: 401,
				message: "GitHub PAT ausente. Rode `wrangler secret put GITHUB_PAT` e tente novamente.",
			};
		}

		const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${REPO_BRANCH}`;
		const headers = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3.raw",
			"User-Agent": "lira-active-context-mcp",
		};

		console.log(`[mcp] fetch ${path} token=${getTokenPreview(token)}`);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

			try {
				const response = await fetch(url, {
					headers,
					signal: controller.signal,
				});
				clearTimeout(timeoutId);

				console.log(`[mcp] ${path} status=${response.status} attempt=${attempt + 1}`);

				if (response.ok) {
					return { ok: true, text: await response.text() };
				}

				if (response.status === 404) {
					return {
						ok: false,
						status: 404,
						message: `Arquivo não encontrado no repo ${REPO_NAME}: ${path}`,
					};
				}

				if (response.status === 401) {
					return {
						ok: false,
						status: 401,
						message: "GitHub PAT inválido ou sem acesso de leitura. Rode `wrangler secret put GITHUB_PAT` com um token fine-grained para o repo lira-active-context.",
					};
				}

				if (response.status === 403) {
					return {
						ok: false,
						status: 403,
						message: `Acesso negado ao GitHub para ${path}. Verifique se o PAT fine-grained tem leitura do repo ${REPO_NAME}.`,
					};
				}

				if (response.status >= 500 && attempt === 0) {
					await sleep(RETRY_BACKOFF_MS);
					continue;
				}

				return {
					ok: false,
					status: response.status,
					message: `Erro ao ler ${path}: HTTP ${response.status}`,
				};
			} catch (error) {
				clearTimeout(timeoutId);

				const errorName = error instanceof Error ? error.name : "Error";
				const errorMessage = error instanceof Error ? error.message : String(error);

				console.log(`[mcp] ${path} attempt=${attempt + 1} error=${errorName}: ${errorMessage}`);

				if (attempt === 0) {
					await sleep(RETRY_BACKOFF_MS);
					continue;
				}

				return {
					ok: false,
					status: 504,
					message: `Erro temporário ao ler ${path}: ${errorMessage}`,
				};
			}
		}

		return {
			ok: false,
			status: 502,
			message: `Erro temporário ao ler ${path}`,
		};
	}
}

abstract class BaseMcpTool<TInput extends Record<string, unknown> = Record<string, never>> {
	abstract readonly definition: ToolDefinition;

	protected constructor(protected readonly client: GitHubContentClient) {}

	abstract execute(input: TInput): Promise<ToolResult>;

	register(server: McpServer): void {
		server.registerTool(
			this.definition.name,
			{
				description: this.definition.description,
				inputSchema: z.object({}).strict(),
			},
			async (input) => this.execute((input ?? {}) as TInput),
		);
	}
}

class McpTool extends BaseMcpTool {
	constructor(
		client: GitHubContentClient,
		readonly definition: ToolDefinition,
	) {
		super(client);
	}

	async execute(): Promise<ToolResult> {
		const result = await this.client.readRaw(this.definition.path);

		if (!result.ok) {
			return createJsonError(result.message);
		}

		if (this.definition.kind === "json") {
			let parsed: unknown;

			try {
				parsed = JSON.parse(result.text);
			} catch {
				return createJsonError(`Conteúdo JSON inválido em ${this.definition.path}`);
			}

			if (!isPlainObject(parsed)) {
				return createJsonError(`Conteúdo JSON inesperado em ${this.definition.path}`);
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(parsed, null, 2),
					},
				],
				structuredContent: parsed,
			};
		}

		return {
			content: [
				{
					type: "text",
					text: result.text,
				},
			],
		};
	}
}

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "lira-active-context",
		version: "1.0.0",
	});

	async init() {
		const client = new GitHubContentClient(this.env);

		for (const definition of TOOL_DEFINITIONS) {
			new McpTool(client, definition).register(this.server);
		}
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean);
		const accessToken = (env as any).ACCESS_TOKEN as string | undefined;

		if (parts[0] !== "mcp" || !accessToken || parts[1] !== accessToken) {
			return new Response("Not found", { status: 404 });
		}

		url.pathname = "/mcp";
		return MyMCP.serve("/mcp").fetch(new Request(url.toString(), request), env, ctx);
	},
};

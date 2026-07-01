/**
 * Todo extension. State from session tool results -> branches get matching todos.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

class TodoListComponent {
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		private todos: Todo[],
		private theme: Theme,
		private onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [""];
		const title = th.fg("accent", " Todos ");
		lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))), width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some.")}`, width));
		} else {
			const done = this.todos.filter((t) => t.done).length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${this.todos.length} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("", truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width), "");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function todoExtension(pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;

	function reconstructState(ctx: ExtensionContext) {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (!details) continue;
			todos = details.todos;
			nextId = details.nextId;
		}
	}

	function snapshot(action: TodoDetails["action"], error?: string): TodoDetails {
		return { action, todos: todos.map((t) => ({ ...t })), nextId, ...(error ? { error } : {}) };
	}

	pi.on("session_start", (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage session todos. Actions: list, add (text), toggle (id), clear.",
		promptSnippet: "Manage session todos: list, add, toggle, clear",
		promptGuidelines: ["Use todo for session task lists when user asks to track work items."],
		parameters: TodoParams,
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text" as const, text: todos.length ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n") : "No todos" }],
						details: snapshot("list"),
					};

				case "add": {
					if (!params.text) {
						return { content: [{ type: "text" as const, text: "Error: text required for add" }], details: snapshot("add", "text required") };
					}
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					return { content: [{ type: "text" as const, text: `Added todo #${newTodo.id}: ${newTodo.text}` }], details: snapshot("add") };
				}

				case "toggle": {
					if (params.id === undefined) {
						return { content: [{ type: "text" as const, text: "Error: id required for toggle" }], details: snapshot("toggle", "id required") };
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return { content: [{ type: "text" as const, text: `Todo #${params.id} not found` }], details: snapshot("toggle", `#${params.id} not found`) };
					}
					todo.done = !todo.done;
					return { content: [{ type: "text" as const, text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }], details: snapshot("toggle") };
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return { content: [{ type: "text" as const, text: `Cleared ${count} todos` }], details: snapshot("clear") };
				}
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					let text = theme.fg("muted", `${todoList.length} todo(s):`);
					for (const t of expanded ? todoList : todoList.slice(0, 5)) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						text += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) text += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					return new Text(text, 0, 0);
				}
				case "add": {
					const added = todoList.at(-1);
					return new Text(added ? theme.fg("success", "✓ Added ") + theme.fg("accent", `#${added.id}`) + " " + theme.fg("muted", added.text) : "", 0, 0);
				}
				case "toggle": {
					const text = result.content[0];
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
				}
				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoListComponent(todos, theme, () => done()));
		},
	});
}

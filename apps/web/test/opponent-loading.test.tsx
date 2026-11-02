import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Library, exampleDeck } from "../src/Library.tsx";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  let finish!: (value: Response) => void;
  let saved = false;
  const opponent = { schemaVersion: 1, id: "new-opponent", name: "新 AI 对手", deck: exampleDeck, strategies: [] };
  const fetch = vi.fn((url: string, options?: RequestInit) => {
    if (options?.method === "POST") return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(new Response(JSON.stringify(url.endsWith("/decks")
      ? { decks: [{ id: "deck", deck: exampleDeck, createdAt: "2026-11-02", updatedAt: "2026-11-02" }] }
      : { opponents: saved ? [opponent] : [] })));
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, finish(response: Response) { finish(response); }, succeed() { saved = true; finish(new Response(JSON.stringify(opponent))); } };
}

async function openEditor() {
  render(<Library />);
  await screen.findByRole("heading", { name: exampleDeck.name });
  fireEvent.click(screen.getByRole("button", { name: /^AI 对手/ }));
  fireEvent.click(screen.getByRole("button", { name: /创建 AI 对手/ }));
  return screen.getByRole("dialog", { name: "AI 对手与长期策略" });
}

it("创建期间显示等待状态，阻止重复提交与关闭，成功后显示新对手", async () => {
  const api = setup();
  const dialog = await openEditor();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存 AI 对手" }));
  expect(dialog).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("status")).toHaveTextContent("正在生成初始策略…");
  const pending = within(dialog).getByRole("button", { name: "创建中…" });
  expect(pending).toBeDisabled();
  for (const control of within(dialog).getAllByRole("textbox")) expect(control).toBeDisabled();
  expect(within(dialog).getByRole("combobox")).toBeDisabled();
  fireEvent.click(pending);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent.mouseDown(dialog.parentElement!);
  expect(dialog).toBeInTheDocument();
  expect(api.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  await act(async () => api.succeed());
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("heading", { name: "新 AI 对手" })).toBeInTheDocument();
});

it("创建失败后解除等待并保留输入，重试会清除旧错误", async () => {
  const api = setup();
  const dialog = await openEditor();
  const name = within(dialog).getByLabelText("对手名称");
  fireEvent.change(name, { target: { value: "保留的对手名称" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存 AI 对手" }));
  await act(async () => api.finish(new Response(JSON.stringify({ error: { message: "模型暂不可用" } }), { status: 503 })));
  expect(within(dialog).getByRole("alert")).toHaveTextContent("模型暂不可用");
  expect(dialog).toHaveAttribute("aria-busy", "false");
  expect(name).toHaveValue("保留的对手名称");
  expect(name).toBeEnabled();
  expect(within(dialog).getByRole("button", { name: "取消" })).toBeEnabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存 AI 对手" }));
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "创建中…" })).toBeDisabled();
  expect(api.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);
  await act(async () => api.succeed());
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

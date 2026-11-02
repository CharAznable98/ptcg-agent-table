import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelOptionsResponse,
  ModelSettings,
  ModelSettingsInput,
  ReasoningEffort,
} from "../../../packages/protocol/src/index.ts";
import { Settings } from "../src/Settings.tsx";

const config: ModelSettings = {
  schemaVersion: 1,
  model: "current-model",
  reasoningEffort: "medium",
  fast: false,
  apiKeyConfigured: true,
  connection: {
    kind: "openai_compatible",
    baseUrl: "https://first.example/v1",
    protocol: "responses",
    apiKeyFile: "/local/key.json",
  },
};
const prompts = {
  schemaVersion: 1,
  player: "玩家",
  judge: "裁判",
  summary: "总结",
  compactor: "压缩",
  toolDescriptions: {},
  feedback: {},
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function mockApi(
  options: {
    initial?: ModelSettings;
    models?: (input: ModelSettingsInput) => Response | Promise<Response>;
    test?: (input: ModelSettingsInput) => Response | Promise<Response>;
  } = {},
) {
  let saved = structuredClone(options.initial ?? config);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const input = init?.body
      ? (JSON.parse(String(init.body)) as ModelSettingsInput)
      : undefined;
    if (url.endsWith("/models"))
      return (
        options.models?.(input!) ??
        response({
          models: [
            { id: "current-model" },
            { id: "another-model", reasoningEfforts: ["low", "high"] },
          ],
        })
      );
    if (url.endsWith("/test"))
      return (
        options.test?.(input!) ??
        response({ ok: true, model: input!.model, elapsedMs: 9 })
      );
    if (url.endsWith("/model")) {
      if (init?.method === "PUT") {
        const { apiKey: key, ...value } = input!;
        saved = {
          ...value,
          apiKeyConfigured: Boolean(key) || saved.apiKeyConfigured,
        };
      }
      return response(saved);
    }
    return response(prompts);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function payload(
  fetch: ReturnType<typeof mockApi>,
  suffix: string,
  method = "POST",
) {
  const call = fetch.mock.calls.findLast(
    ([url, init]) => url.endsWith(suffix) && init?.method === method,
  );
  return call
    ? (JSON.parse(String(call[1]!.body)) as ModelSettingsInput)
    : undefined;
}
async function mount() {
  render(<Settings />);
  await screen.findByRole("heading", { name: "模型连接" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled(),
  );
}
async function refresh() {
  fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled(),
  );
}

describe("模型连接设置", () => {
  it("网页直接保存 API Key，保存后不回显正文，空输入保留密钥", async () => {
    const fetch = mockApi();
    await mount();
    const key = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.autocomplete).toBe("off");
    expect(key.value).toBe("");
    expect(key.placeholder).toBe("已保存 API Key");
    expect(
      screen.queryByLabelText("API Key 环境变量名称"),
    ).not.toBeInTheDocument();
    fireEvent.change(key, { target: { value: "test-secret-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await screen.findByText("模型配置已保存");
    expect(payload(fetch, "/model", "PUT")).toMatchObject({
      apiKey: "test-secret-key",
    });
    expect(payload(fetch, "/model", "PUT")).not.toHaveProperty(
      "apiKeyConfigured",
    );
    expect(key.value).toBe("");
    expect(localStorage.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([, init]) => init?.method === "PUT"),
      ).toHaveLength(2),
    );
    expect(payload(fetch, "/model", "PUT")).not.toHaveProperty("apiKey");
  });

  it("模型和思考强度使用选择控件，并按模型能力限制选项", async () => {
    const fetch = mockApi();
    await mount();
    const model = screen.getByRole("combobox", { name: "模型" });
    const effort = screen.getByRole("combobox", { name: "思考强度" });
    fireEvent.change(model, { target: { value: "another-model" } });
    expect(effort).toHaveValue("medium");
    expect(screen.getByRole("button", { name: "保存模型配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    expect(
      within(effort)
        .getAllByRole("option")
        .filter((option) => !(option as HTMLOptionElement).disabled)
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["default", "low", "high"]);
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await screen.findByText("模型配置已保存");
    expect(payload(fetch, "/model", "PUT")).toMatchObject({
      model: "another-model",
      reasoningEffort: "high",
    });
  });

  it("刷新能力后保留不支持的旧档位，明确选择允许档位前不发送请求", async () => {
    const fetch = mockApi({
      models: () => response({
        models: [{ id: "current-model", reasoningEfforts: ["max", "high", "low", "none"], defaultReasoningEffort: "high" }],
      }),
    });
    await mount();
    const effort = screen.getByRole("combobox", { name: "思考强度" });
    expect(effort).toHaveValue("medium");
    expect(within(effort).getByRole("option", { name: "中（medium） · 不支持" })).toBeDisabled();
    expect(within(effort).getByRole("option", { name: "接口默认 · 高（high）" })).toHaveValue("default");
    expect(screen.getByText("当前模型不支持 medium，请选择思考强度。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    expect(payload(fetch, "/test")).toBeUndefined();
    expect(payload(fetch, "/model", "PUT")).toBeUndefined();
    await refresh();
    expect(effort).toHaveValue("medium");
    fireEvent.change(effort, { target: { value: "low" } });
    expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText("连接成功 · current-model · 9 ms");
    expect(payload(fetch, "/test")?.reasoningEffort).toBe("low");
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await screen.findByText("模型配置已保存");
    expect(payload(fetch, "/model", "PUT")?.reasoningEffort).toBe("low");
  });

  it("接口新增档位直接显示并提交，不受固定文案表限制", async () => {
    const fetch = mockApi({
      initial: { ...config, reasoningEffort: "default" },
      models: () => response({
        models: [{ id: "current-model", reasoningEfforts: ["high", "ultra"], defaultReasoningEffort: "ultra" }],
      }),
    });
    await mount();
    const effort = screen.getByRole("combobox", { name: "思考强度" });
    expect(within(effort).getByRole("option", { name: "接口默认 · ultra" })).toHaveValue("default");
    expect(within(effort).getByRole("option", { name: "ultra" })).toHaveValue("ultra");
    fireEvent.change(effort, { target: { value: "ultra" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await screen.findByText("模型配置已保存");
    expect(payload(fetch, "/model", "PUT")?.reasoningEffort).toBe("ultra");
  });

  it("未报告能力时只保留默认和已有配置，不猜测全部档位", async () => {
    mockApi();
    await mount();
    const effort = screen.getByRole("combobox", { name: "思考强度" });
    expect(within(effort).getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["default", "medium"]);
    expect(effort).toHaveValue("medium");
    expect(screen.getByText("接口未提供思考档位，当前值未确认。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存模型配置" })).toBeEnabled();
  });

  it("明确不开放档位时只允许默认，mandatory 模型不可选择 none", async () => {
    mockApi({
      initial: { ...config, reasoningEffort: "default" },
      models: () => response({ models: [
        { id: "current-model", reasoningEfforts: [], defaultReasoningEffort: "none" },
        { id: "required-model", reasoningEfforts: ["none", "low", "high"], reasoningRequired: true, defaultReasoningEffort: "high" },
      ] }),
    });
    await mount();
    const effort = screen.getByRole("combobox", { name: "思考强度" });
    expect(within(effort).getAllByRole("option")).toHaveLength(1);
    expect(within(effort).getByRole("option", { name: "接口默认 · 不启用（none）" })).toHaveValue("default");
    fireEvent.change(screen.getByRole("combobox", { name: "模型" }), { target: { value: "required-model" } });
    expect(within(effort).queryByRole("option", { name: "不启用（none）" })).not.toBeInTheDocument();
    expect(within(effort).getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["default", "low", "high"]);
  });

  it("刷新模型和测试连接直接使用未保存的表单", async () => {
    const fetch = mockApi();
    await mount();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "draft-key" },
    });
    fireEvent.change(screen.getByLabelText("接口协议"), {
      target: { value: "chat_completions" },
    });
    await refresh();
    expect(payload(fetch, "/models")).toMatchObject({
      apiKey: "draft-key",
      connection: { protocol: "chat_completions" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "模型" }), {
      target: { value: "another-model" },
    });
    fireEvent.change(screen.getByLabelText("思考强度"), {
      target: { value: "low" },
    });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText("连接成功 · another-model · 9 ms");
    expect(payload(fetch, "/test")).toMatchObject({
      apiKey: "draft-key",
      model: "another-model",
      reasoningEffort: "low",
      connection: { protocol: "chat_completions" },
    });
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false,
    );
  });

  it("更换接口地址会清空密钥引用和草稿，刷新后才能使用新模型", async () => {
    const fetch = mockApi({
      initial: {
        ...config,
        connection: {
          kind: "openai_compatible",
          baseUrl: "https://first.example/v1",
          protocol: "responses",
          apiKeyFile: "/local/key.json",
          apiKeyEnv: "OLD_KEY",
        },
      },
    });
    await mount();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "old-draft-key" },
    });
    fireEvent.change(screen.getByLabelText("接口地址"), {
      target: { value: "https://second.example/v1" },
    });
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByLabelText("API Key")).toHaveAttribute(
      "placeholder",
      "填写 API Key",
    );
    expect(screen.getByLabelText("模型")).toHaveValue("");
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "new-draft-key" },
    });
    await refresh();
    const input = payload(fetch, "/models")!;
    expect(input.apiKey).toBe("new-draft-key");
    expect(input.connection.baseUrl).toBe("https://second.example/v1");
    expect(input.connection).not.toHaveProperty("apiKeyFile");
    expect(input.connection).not.toHaveProperty("apiKeyEnv");
    expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled();
  });

  it("模型列表读取失败可以重试，编辑后清除旧提示", async () => {
    let calls = 0;
    mockApi({
      models: () =>
        ++calls === 1
          ? response({ error: { message: "模型列表读取失败" } }, 502)
          : response({ models: [{ id: "retry-model" }] }),
    });
    await mount();
    expect(screen.getByRole("alert")).toHaveTextContent("模型列表读取失败");
    await refresh();
    expect(screen.getByLabelText("模型")).toHaveValue("retry-model");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText("连接成功 · retry-model · 9 ms");
    fireEvent.change(screen.getByLabelText("思考强度"), {
      target: { value: "default" },
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("旧地址返回的模型列表不会覆盖新地址的结果", async () => {
    let finishOld!: (response: Response) => void;
    mockApi({
      models: (input) =>
        input.connection.baseUrl === "https://first.example/v1"
          ? new Promise<Response>((resolve) => {
              finishOld = resolve;
            })
          : response({ models: [{ id: "new-host-model" }] }),
    });
    render(<Settings />);
    await screen.findByRole("button", { name: "读取模型中…" });
    fireEvent.change(screen.getByLabelText("接口地址"), {
      target: { value: "https://second.example/v1" },
    });
    await refresh();
    expect(screen.getByLabelText("模型")).toHaveValue("new-host-model");
    await act(async () =>
      finishOld(
        response({
          models: [{ id: "old-host-model" }],
        } satisfies ModelOptionsResponse),
      ),
    );
    expect(screen.getByLabelText("模型")).toHaveValue("new-host-model");
    expect(
      screen.queryByRole("option", { name: "old-host-model" }),
    ).not.toBeInTheDocument();
  });

  it("切换连接方式后丢弃密钥草稿，本地模式也通过下拉选择模型", async () => {
    const fetch = mockApi();
    await mount();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "discarded-draft" },
    });
    fireEvent.change(screen.getByLabelText("连接方式"), {
      target: { value: "local_codex_credentials" },
    });
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    await refresh();
    expect(payload(fetch, "/models")).not.toHaveProperty("apiKey");
    expect(payload(fetch, "/models")).toMatchObject({
      connection: { kind: "local_codex_credentials" },
    });
    expect(screen.getByRole("combobox", { name: "模型" })).toBeInTheDocument();
    const efforts = within(screen.getByLabelText("思考强度"))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(efforts).toEqual(["default", "medium"] satisfies ReasoningEffort[]);
  });
});

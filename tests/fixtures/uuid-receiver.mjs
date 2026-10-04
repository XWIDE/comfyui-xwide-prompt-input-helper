/**
 * 用户真机上的那种接收节点（2026-10 抓到的**第二个**「桩里全绿、真机全错」）。
 *
 * 真机工作流（`X_WIDE_Qwen+image+2.1 …json`，182 个节点）里长这样：
 *
 *   #90  Image Edit (Qwen Image 2.1)   type = "ae6b6fa6-bcc6-494c-a8e0-d79c9b933ac9"（UUID！）
 *        ├ inputs[0] name="system_prompt"
 *        ├ inputs[1] name="prompt"           label="positive_prompt"   ← 正反写在 label 上
 *        └ inputs[2] name="negative_prompt"
 *   #91  type="Prompt"（不是 CLIPTextEncode，类型名里一个提示词关键词都没有） → #90 的 1 号口
 *   #92  type="Prompt"                                                       → #90 的 2 号口
 *
 * 为什么不复用 sampler-chain 那块样板：那块图**必须**是 KSampler + CLIPTextEncode，
 * 因为它要测的是「同样是 CLIPTextEncode，靠线落在哪个口区分」。这里要测的恰好相反 ——
 * 靠的是**节点类型名之外的东西**：
 *
 *   ① 老插件只读入口的真名（`name = "prompt"`），词表里没有它 → 认不出正反
 *      （写着正反的 `positive_prompt` 在 `label` 上，而 `label` 老插件根本不读）；
 *   ② 老插件按**节点类型名**决定"这条线值不值得追"（`CHAIN_NODE_RE`），而接收节点的
 *      类型名是 UUID、上游是 "Prompt"，两边一个关键词都不命中 → 第一步就 `stop:"off-chain"`。
 *
 * 这两条叠在一起，就是用户报的「写到正有的时候会填到反里面，写到反，有的时候会填到正里面」。
 *
 * 控件的名字按真机来：那两个框的控件叫 `value`（不是 `text`、也不含正反字样），
 * 所以在这块图上「按控件名认正反」也是不通的 —— **只有线能说话**。
 */

/** 真机上那个接收节点的入口表。label 才是用户屏幕上看到的那个名字。 */
const RECEIVER_INPUTS = [
  { name: "system_prompt" },
  { name: "prompt", label: "positive_prompt" },
  { name: "negative_prompt" },
];

/**
 * 造一块"真机同形"的图，并把它切成当前工作流。
 *
 * 返回 `{ graph, receiver, positive, negative, positiveArea, negativeArea }`。
 * `spec.positive === null`（或 `spec.negative === null`）表示**那个框不存在** ——
 * 用来造"只有一边能认出来"的情形（配对、指错边的旧绑定都靠它复现）。
 */
export function buildUuidReceiver(env, spec = {}) {
  const graph = env.newGraph();
  env.useGraph(graph);

  const receiver = env.addNode({
    graph,
    id: spec.receiverId ?? 90,
    type: spec.receiverType || "ae6b6fa6-bcc6-494c-a8e0-d79c9b933ac9",
    title: spec.receiverTitle || "Image Edit (Qwen Image 2.1)",
    widgets: [null], // cfg / steps / sampler 那一堆非文本控件
    inputs: RECEIVER_INPUTS.map((i) => ({ ...i })),
  });

  const makeBox = (id, value) =>
    env.addNode({
      graph,
      id,
      type: "Prompt",
      title: "Prompt",
      widgets: [{ name: "value", displayName: "value", value }],
      outputs: [{ name: "STRING", type: "STRING" }],
    });

  const positive = spec.positive === null ? null : makeBox(spec.positiveId ?? 91, spec.positiveValue ?? "");
  const negative = spec.negative === null ? null : makeBox(spec.negativeId ?? 92, spec.negativeValue ?? "老的反向内容");

  // 线必须两边都写（源节点 outputs[].links + graph.links 那条记录），见 harness.addLink。
  if (positive) env.addLink(graph, positive.id, 0, receiver.id, 1);
  if (negative) env.addLink(graph, negative.id, 0, receiver.id, 2);

  return {
    graph,
    receiver,
    positive,
    negative,
    positiveArea: positive ? positive._textareas[0] : null,
    negativeArea: negative ? negative._textareas[0] : null,
  };
}

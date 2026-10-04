/**
 * 一块"真机长什么样"的样板图：两个 CLIP 文本编码 → 一个采样器。
 *
 * 为什么要有这东西：
 *   插件判定"这个提示词框是正向还是反向"的**唯一依据**是线落到对面节点的哪个入口
 *   （`positive` / `negative`）。桩里如果只造节点、不造线，插件只能走到 "dead-end"，
 *   于是每个框都认不出角色 —— 那测出来的是"桩不会造线"，不是"插件认不出线"。
 *
 * 这里刻意做成通用规格：`buildSamplerChain(env, spec)` 接受两套编码器规格，
 * 甚至接受规格为 `null`（那条线不接），好让测试能造出"分不清"的情形。
 */

/** 采样器那四个入口的名字。真机上 `inputs[i].label` 是 null，只有 name 能认。 */
const SAMPLER_INPUTS = [{ name: "model" }, { name: "positive" }, { name: "negative" }, { name: "latent_image" }];

/**
 * 默认的编码器规格。value 默认给空串是为了让"写进去了没有"一眼能看出来 ——
 * 如果两边都预置了内容，断言就得靠比较，容易写成"断言自己刚写的那串"。
 */
function defaultEncoder(id, value) {
  return {
    id,
    type: "CLIPTextEncode",
    title: "CLIP文本编码",
    widgets: [{ name: "text", displayName: "text", value }],
    outputs: [{ name: "CONDITIONING", type: "CONDITIONING" }],
  };
}

/**
 * 造一张 [正向编码] + [反向编码] → [采样器] 的图，并把它切成当前工作流。
 *
 * 返回 { graph, sampler, positive, negative, positiveArea, negativeArea }。
 * `positive` / `negative` 传 null 表示那条线不接（用来验证"认不出来"的分支）。
 */
export function buildSamplerChain(env, spec = {}) {
  const graph = env.newGraph();
  env.useGraph(graph);

  const samplerSpec = spec.sampler || {
    id: 70,
    type: "KSampler",
    title: "K采样器",
  };

  // 采样器先建：线的记录要往源节点的 outputs[].links 里回填，源节点必须已经存在
  // （见 harness 的 addNode 注释）。
  const sampler = env.addNode({
    graph,
    id: samplerSpec.id,
    type: samplerSpec.type,
    title: samplerSpec.title,
    widgets: [null], // 种子那类非文本控件：不该被当成提示词框
    inputs: SAMPLER_INPUTS.map((i) => ({ ...i })),
  });

  const positiveSpec = spec.positive === null ? null : spec.positive || defaultEncoder(67, "");
  const negativeSpec = spec.negative === null ? null : spec.negative || defaultEncoder(71, "blurry, lowres");

  let positive = null;
  let negative = null;

  if (positiveSpec) {
    positive = env.addNode({
      ...positiveSpec,
      graph,
      type: positiveSpec.type || "CLIPTextEncode",
      title: positiveSpec.title || "CLIP文本编码",
      outputs: positiveSpec.outputs || [{ name: "CONDITIONING", type: "CONDITIONING" }],
    });
    // 正向那条线落到采样器的 positive 入口。
    env.addLink(graph, positive.id, 0, sampler.id, 1);
  }

  if (negativeSpec) {
    negative = env.addNode({
      ...negativeSpec,
      graph,
      type: negativeSpec.type || "CLIPTextEncode",
      title: negativeSpec.title || "CLIP文本编码",
      outputs: negativeSpec.outputs || [{ name: "CONDITIONING", type: "CONDITIONING" }],
    });
    env.addLink(graph, negative.id, 0, sampler.id, 2);
  }

  return {
    graph,
    sampler,
    positive,
    negative,
    positiveArea: positive ? positive._textareas[0] : null,
    negativeArea: negative ? negative._textareas[0] : null,
  };
}

/** 诊断：import.meta.url 与 ROUTE 反推在 test harness 下到底拿到什么。 */
import { createEnv, fileUrl } from "./harness.mjs";

createEnv();
globalThis.document.URL = "http://localhost:8188/";

const u = fileUrl("../web/js/prompt_helper.js");
console.log("fileUrl 结果      :", String(u));
console.log("u.pathname        :", u.pathname);
console.log("正则 /\\/web\\/([^/]+)\\// :", String(u).match(/\/web\/([^/]+)\//));
console.log("正则 /\\/([^/]+)\\/js\\// :", String(u).match(/\/([^/]+)\/js\/prompt_helper\.js/));

await import(u);
const api = globalThis.__xwidePromptHelperInternals;
console.log("routeName()       :", api && api.routeName && api.routeName());
console.log("logoUrl()         :", api && api.__logoUrl && api.__logoUrl());

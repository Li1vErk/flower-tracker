/*
 * 把 flower-tracker.html 编译成「零外部依赖」的部署版。
 *
 * 源文件保持原样（本地双击可用，靠 CDN + 浏览器内 Babel 编译）,
 * 本脚本产出 deploy/index.html：React / ReactDOM / lz-string 全部内联，
 * JSX 预编译成普通 JS，字体改为异步加载，并加一道访问口令。
 *
 * 用法：  node build-deploy.js
 *         node build-deploy.js 我的口令     （不传则用默认口令）
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "flower-tracker.html");
const VENDOR = path.join(ROOT, "vendor");
const OUT_DIR = path.join(ROOT, "deploy");
const OUT = path.join(OUT_DIR, "index.html");

const GATE_PASSWORD = process.argv[2] || "huayuan";
const GATE_KEY = "xhx-gate-ok";

function readVendor(name) {
  const p = path.join(VENDOR, name);
  if (!fs.existsSync(p)) {
    console.error("缺少 vendor/" + name + "，请先下载依赖（见 README）。");
    process.exit(1);
  }
  return fs.readFileSync(p, "utf8");
}

function inline(js) {
  return js.replace(/<\/script/gi, "<\\/script");
}

function djb2(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0;
  return x.toString(36);
}

// 口令输入容错：用户实际输入时很容易带进杂质——复制粘贴带尾随空格/换行、
// 从消息里框选带全角冒号、中文输入法打出全角字符、手机/浏览器自动首字母大写。
// 构建期对目标口令、运行期对用户输入做同一套归一化，保证这些姿势都能进。
// 归一化 = 去掉所有空白 + 全角 ASCII 转半角 + 统一小写 + 只保留字母和数字。
// 两端规则必须一致（构建端先归一化再算哈希），所以口令里的符号「形同虚设」，
// 归一化后为空的口令直接拒绝构建，防止出现空口令直接放行。
function normInput(s) {
  return s
    .replace(/\s+/g, "")
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const Babel = require(path.join(VENDOR, "babel.min.js"));

let html = fs.readFileSync(SRC, "utf8");
const report = [];

// ---------- 1. 提取 JSX 并预编译 ----------
const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!m) {
  console.error("找不到 <script type=\"text/babel\"> 代码块。");
  process.exit(1);
}
let compiled;
try {
  compiled = Babel.transform(m[1], {
    presets: ["react"],
    filename: "flower-tracker.jsx",
    compact: false,
    comments: false,
  }).code;
} catch (e) {
  console.error("JSX 编译失败，源文件有语法错误：");
  console.error(e.message);
  process.exit(2);
}
report.push(`JSX 编译通过：${m[1].length} → ${compiled.length} 字符`);

// ---------- 2. 内联 React / ReactDOM / lz-string ----------
const pairs = [
  [/<script crossorigin src="https:\/\/unpkg\.com\/react@18\/umd\/react\.production\.min\.js"><\/script>/,
    "<script>\n" + inline(readVendor("react.production.min.js")) + "\n</script>", "React"],
  [/<script crossorigin src="https:\/\/unpkg\.com\/react-dom@18\/umd\/react-dom\.production\.min\.js"><\/script>/,
    "<script>\n" + inline(readVendor("react-dom.production.min.js")) + "\n</script>", "ReactDOM"],
  [/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/lz-string\/1\.5\.0\/lz-string\.min\.js"><\/script>/,
    "<script>\n" + inline(readVendor("lz-string.min.js")) + "\n</script>", "lz-string"],
  [/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/7\.22\.0\/babel\.min\.js"><\/script>\s*\n?/,
    "", "Babel（已预编译，整个移除）"],
];
// 注意：替换内容必须用函数返回。内联的 React 源码里含 `$&` 等片段，
// 直接当替换字符串会被 String.replace 当成特殊模式展开，把代码写坏。
for (const [re, rep, name] of pairs) {
  if (!re.test(html)) {
    console.error(`! 未能匹配外部依赖：${name}`);
    process.exit(3);
  }
  html = html.replace(re, () => rep);
  report.push(`已处理 ${name}`);
}

// ---------- 3. 字体改为异步，不再阻塞首屏 ----------
const fontRe = /<link href="(https:\/\/fonts\.googleapis\.com[^"]*)" rel="stylesheet">/;
if (fontRe.test(html)) {
  html = html.replace(fontRe, (_, url) =>
    `<link rel="stylesheet" href="${url}" media="print" onload="this.media='all'">\n` +
    `  <noscript><link rel="stylesheet" href="${url}"></noscript>`
  );
  report.push("Google 字体改为异步加载（不再阻塞渲染，取不到就用系统字体）");
}

// ---------- 4. 换成预编译后的脚本 ----------
html = html.replace(/<script type="text\/babel">[\s\S]*?<\/script>/,
  () => "<script>\n" + inline(compiled) + "\n</script>");
report.push("JSX 脚本替换为预编译版本");

// ---------- 5. 禁止搜索引擎收录 ----------
html = html.replace("<title>花园复活追踪</title>",
  () => '<title>花园复活追踪</title>\n  <meta name="robots" content="noindex, nofollow, noarchive">');
report.push("已加 noindex（不会被搜索引擎收录）");

// ---------- 6. 访问口令覆盖层 ----------
const gateHash = djb2(normInput(GATE_PASSWORD));
if (!normInput(GATE_PASSWORD)) {
  console.error("! 口令归一化后为空（只统计字母和数字），请换一个口令。");
  process.exit(6);
}
const gateHtml = `
  <div id="xhx-gate" style="position:fixed;inset:0;z-index:99999;background:#0c0c10;display:flex;align-items:center;justify-content:center;font-family:'Noto Sans SC','PingFang SC',system-ui,sans-serif">
    <div style="text-align:center;padding:28px;width:100%;max-width:320px">
      <div style="font-size:34px;line-height:1;margin-bottom:16px">&#128174;</div>
      <div style="font-size:15px;color:#e0d8ec;margin-bottom:22px;letter-spacing:.5px">花园复活追踪</div>
      <input id="xhx-gate-input" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="访问口令"
        style="width:100%;padding:11px 14px;border-radius:10px;border:1px solid #2f2b3a;background:#16141d;color:#e0d8ec;font-size:15px;outline:none;box-sizing:border-box">
      <button id="xhx-gate-btn"
        style="width:100%;margin-top:12px;padding:11px 14px;border-radius:10px;border:none;background:#7c5cbf;color:#fff;font-size:14px;font-weight:600;cursor:pointer">进 入</button>
      <div id="xhx-gate-err" style="margin-top:12px;font-size:13px;color:#e06060;height:18px"></div>
    </div>
  </div>
  <script>
    (function () {
      var HASH = "${gateHash}", KEY = "${GATE_KEY}";
      var gate = document.getElementById("xhx-gate");
      if (!gate) return;
      try { if (sessionStorage.getItem(KEY) === HASH) { gate.remove(); return; } } catch (e) { }
      var input = document.getElementById("xhx-gate-input");
      var btn = document.getElementById("xhx-gate-btn");
      var err = document.getElementById("xhx-gate-err");
      function unlock() {
        if (h(n(input.value)) === HASH) {
          try { sessionStorage.setItem(KEY, HASH); } catch (e) { }
          gate.remove();
        } else {
          err.textContent = "口令不对";
          input.value = "";
          input.focus();
        }
      }
      function h(s) { var x = 5381; for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0; return x.toString(36); }
      function n(s) { return s.replace(/\\s+/g, "").replace(/[\\uFF01-\\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).toLowerCase().replace(/[^a-z0-9]/g, ""); }
      btn.addEventListener("click", unlock);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") unlock(); });
      setTimeout(function () { input.focus(); }, 120);
    })();
  </script>
`;

if (!html.includes('<div id="root"></div>')) {
  console.error("找不到 <div id=\"root\"></div>。");
  process.exit(4);
}
html = html.replace('<div id="root"></div>', () => '<div id="root"></div>' + gateHtml);
report.push(`已加访问口令层（口令：${GATE_PASSWORD}，哈希 ${gateHash}，输入容错：忽略空格/全角/大小写）`);

// ---------- 6.5 应用图标 + manifest ----------
// 页面会被「安装成应用 / 添加到主屏幕」：Chromium 安装时优先用 manifest 的 icons，
// 没有 manifest 就把 favicon 放大，又小又糊。这里注入一个运行时拼装的内联
// manifest（data URI，不破坏单文件、零外部请求），并用同一张 PNG 换掉 emoji favicon。
// start_url 不能写死（部署地址因人而异），所以在运行期用 location 现算。
const ICON_PATH = path.join(ROOT, "icon-512.png");
if (fs.existsSync(ICON_PATH)) {
  const iconUri = "data:image/png;base64," + fs.readFileSync(ICON_PATH).toString("base64");
  const faviconRe = /<link rel="icon"\s+href="data:image\/svg\+xml[^>]*>/;
  if (!faviconRe.test(html)) {
    console.error("! 源文件里找不到 emoji favicon，应用图标注入跳过。");
  } else {
    html = html.replace(faviconRe, () =>
      '<link rel="icon" type="image/png" sizes="512x512" href="' + iconUri + '">');
    const manifestScript = `
  <meta name="theme-color" content="#17141f">
  <script>
    (function () {
      try {
        var icon = "${iconUri}";
        var isHttp = location.protocol === "https:" || location.protocol === "http:";
        var m = {
          name: "\\u82B1\\u56ED\\u590D\\u6D3B\\u8FFD\\u8E2A",
          short_name: "\\u82B1\\u56ED\\u8FFD\\u8E2A",
          description: "\\u591A\\u8D26\\u53F7\\u82B1\\u6735\\u67AF\\u840E\\u5012\\u8BA1\\u65F6\\u4E0E\\u6536\\u96C6\\u8FDB\\u5EA6\\u8FFD\\u8E2A",
          start_url: isHttp ? location.origin + location.pathname : "./",
          display: "standalone",
          background_color: "#17141f",
          theme_color: "#17141f",
          icons: [{ src: icon, sizes: "512x512", type: "image/png", purpose: "any" }]
        };
        var link = document.createElement("link");
        link.rel = "manifest";
        link.href = "data:application/manifest+json," + encodeURIComponent(JSON.stringify(m));
        document.head.appendChild(link);
      } catch (e) { }
    })();
  </script>`;
    html = html.replace("</head>", () => manifestScript + "\n</head>");
    report.push("已注入应用图标（512px PNG 内联：favicon 替换 + 运行时 manifest，装成应用不再是放大版 emoji）");
  }
} else {
  console.error("! 缺少 icon-512.png，跳过应用图标注入（安装后仍是 favicon 放大版）。");
}

// ---------- 7. 构建期自检 ----------
const leaks = [];
for (const bad of ["unpkg.com", "cdnjs.cloudflare.com", "type=\"text/babel\""]) {
  if (html.includes(bad)) leaks.push(bad);
}
if (leaks.length) {
  console.error("! 产物里仍残留外部依赖 / 未编译内容：" + leaks.join(", "));
  process.exit(5);
}
report.push("自检通过：无 unpkg / cdnjs 残留，无未编译的 text/babel");

// ---------- 8. 输出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, "utf8");

const outSize = Buffer.byteLength(html, "utf8");
console.log(report.map(r => "  ✓ " + r).join("\n"));
console.log("\n产出：" + OUT);
console.log("大小：" + (outSize / 1024).toFixed(0) + " KB（源文件 " +
  (Buffer.byteLength(fs.readFileSync(SRC), "utf8") / 1024).toFixed(0) + " KB）");
console.log("外部依赖：无（React/ReactDOM/lz-string 内联，JSX 预编译，字体异步）");

/**
 * @typedef {object} ToolboxDockOptions
 * @property {string} gatewayURL Anteros status panel URL.
 * @property {() => string | Promise<string>} getToken The IDE's credential getter.
 * @property {string} [member] Default stable member ID.
 * @property {HTMLElement} [mount] Host element for the dock.
 */

/** @param {ToolboxDockOptions} options */
export function installToolboxDock(options) {
  const gateway = new URL(options.gatewayURL);
  if (!["https:", "http:"].includes(gateway.protocol) || gateway.username || gateway.password) {
    throw new Error("请给出安忒洛斯面板的 HTTP(S) 地址。");
  }
  const root = document.createElement("div");
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { position:fixed; inset:0 0 auto; z-index:10001; font:14px/1.5 system-ui,sans-serif; color:#241d18; }
      .opener { position:absolute; top:0; left:50%; transform:translateX(-50%); border-radius:0 0 5px 5px; }
      .panel { box-sizing:border-box; position:absolute; top:36px; left:50%; transform:translateX(-50%); width:min(700px,95vw);
        max-height:80vh; overflow:auto; background:#f6f2e9; border:1px solid #a79c8d; padding:16px; box-shadow:0 14px 45px #1a120d48; }
      button,input,select { font:inherit; color:inherit; background:#fffdf7; border:1px solid #b8ac9c; border-radius:4px; padding:5px 8px; }
      button { cursor:pointer; }
      button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible { outline:2px solid #972e23; outline-offset:2px; }
      a { color:#972e23; }
      label { display:flex; flex-direction:column; gap:4px; }
      .row { display:flex; align-items:end; gap:8px; flex-wrap:wrap; margin-bottom:9px; }
      .spacer { margin-left:auto; }
      .drop { border:1px dashed #5f5043; padding:12px; margin:12px 0; }
      .item { border-top:1px solid #cbbfae; padding:8px 0; overflow-wrap:anywhere; }
      p { margin:4px 0; }
      [hidden] { display:none !important; }
    </style>
    <button class="opener" type="button" aria-expanded="false">工具箱</button>
    <section class="panel" aria-label="安忒洛斯工具箱" hidden>
      <div class="row">
        <label>成员 <select class="member"></select></label>
        <label>分类 <select class="category">
          <option value="">全部</option><option>前端</option><option>工具</option><option>资源</option><option>其它</option>
        </select></label>
        <button class="close spacer" type="button">收起</button>
      </div>
      <div class="drop" tabindex="0">可拖入网址、图片、文件，或在这里粘贴图片。
        <input class="files" type="file" multiple aria-label="选择文件">
      </div>
      <div class="row">
        <label>网址 <input class="url" type="url"></label>
        <button class="save" type="button">收藏</button>
      </div>
      <div class="row">
        <label>关键词 <input class="query" type="search"></label>
        <button class="search" type="button">查找</button>
        <label class="targets" hidden>发到 <select class="target" aria-label="发送目的地"></select></label>
      </div>
      <p class="notice" role="status" aria-live="polite"></p>
      <div class="items"></div>
    </section>
  `;
  const get = selector => shadow.querySelector("." + selector);
  const show = message => { get("notice").textContent = message; };
  let selectedMember = options.member ?? "";
  let disposed = false;
  let initial = false;
  let searchVersion = 0;

  async function api(path, method = "GET", content, type) {
    const token = await options.getToken();
    if (!token) throw new Error("请在 IDE 凭据中配置面板令牌。");
    if (disposed) throw new Error("工具箱已关闭。");
    const headers = { Authorization: "Bearer " + token };
    if (type) headers["Content-Type"] = type;
    const response = await fetch(new URL(path, gateway), {
      method, headers, body: content, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      const reply = await response.json().catch(() => ({}));
      throw new Error(reply.error || "工具箱请求失败。");
    }
    return response;
  }

  function query(values = {}) {
    const parameters = new URLSearchParams(values);
    if (selectedMember) parameters.set("member", selectedMember);
    const category = get("category").value;
    if (category) parameters.set("category", category);
    return parameters;
  }

  async function download(item) {
    const response = await api("/api/family/artifact?" + query({ id: item.artifact }));
    const url = URL.createObjectURL(await response.blob());
    const save = document.createElement("a");
    save.href = url;
    save.download = item.name;
    save.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function send(item) {
    const destination = get("target").value;
    if (!destination) throw new Error("请先选择发送目的地。");
    const requestId = crypto.randomUUID();
    const response = await api("/api/family/toolbox/send?" + query(), "POST",
      JSON.stringify({ id: item.id, destination, requestId }), "application/json");
    const receipt = await response.json();
    show("投递已登记" + (receipt.id ? "，编号 " + receipt.id : "") + "。");
  }

  function action(callback) {
    return async event => {
      try { await callback(event); } catch (error) { show(error instanceof Error ? error.message : "操作失败。"); }
    };
  }

  function itemView(item, canSend) {
    const row = document.createElement("div");
    row.className = "item";
    const title = item.url ? document.createElement("a") : document.createElement("p");
    title.textContent = item.name;
    if (item.url) {
      title.href = item.url;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
    }
    const detail = document.createElement("p");
    detail.textContent = [item.category, item.note ?? item.description, ...(item.tags ?? [])].filter(Boolean).join(" · ");
    row.append(title, detail);
    if (item.artifact) {
      const button = document.createElement("button");
      button.textContent = "下载";
      button.onclick = action(() => download(item));
      row.append(button);
    }
    if (canSend) {
      const button = document.createElement("button");
      button.textContent = "发送";
      button.onclick = action(() => send(item));
      row.append(button);
    }
    return row;
  }

  async function search() {
    const version = ++searchVersion;
    const response = await api("/api/family/toolbox?" + query({ query: get("query").value }));
    const result = await response.json();
    if (version !== searchVersion || disposed) return;
    initial = true;
    selectedMember = result.member;
    get("member").replaceChildren(...result.members.map(member => new Option(member.name, member.id)));
    get("member").value = selectedMember;
    const destination = get("target").value;
    const destinations = result.destinations;
    get("targets").hidden = !destinations.length;
    get("target").replaceChildren(new Option("选择目的地", ""), ...destinations.map(alias => new Option(alias, alias)));
    if (destinations.includes(destination)) get("target").value = destination;
    const list = get("items");
    list.replaceChildren(...result.items.map(item => itemView(item, destinations.length > 0)));
    if (!result.items.length) list.textContent = "暂无收藏";
  }

  async function capture(files, urls) {
    if (files.length + urls.length < 1 || files.length + urls.length > 8) throw new Error("一次可收纳 1 到 8 项。");
    for (const file of files) {
      await api("/api/family/toolbox/file?" + query({ name: file.name || "clipboard.png" }), "PUT", file,
        file.type || "application/octet-stream");
    }
    await Promise.all(urls.map(url => api("/api/family/toolbox/url?" + query(), "POST", JSON.stringify({ url }), "application/json")));
    show("已收纳。");
    await search();
  }

  function open() {
    get("panel").hidden = false;
    get("opener").setAttribute("aria-expanded", "true");
    if (!initial) void action(search)();
  }
  function close() {
    get("panel").hidden = true;
    get("opener").setAttribute("aria-expanded", "false");
  }
  get("opener").onclick = open;
  get("opener").onmouseenter = open;
  get("close").onclick = close;
  get("member").onchange = action(async () => { selectedMember = get("member").value; await search(); });
  get("category").onchange = action(search);
  get("search").onclick = action(search);
  get("query").onkeydown = event => { if (event.key === "Enter") void action(search)(); };
  get("files").onchange = action(async () => {
    await capture([...get("files").files], []);
    get("files").value = "";
  });
  get("save").onclick = action(async () => {
    await capture([], [get("url").value]);
    get("url").value = "";
  });
  get("drop").ondragover = event => event.preventDefault();
  get("drop").ondrop = action(async event => {
    event.preventDefault();
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const urls = transfer.getData("text/uri-list").split(/\r?\n/).filter(line => line && !line.startsWith("#"));
    await capture([...transfer.files], urls);
  });
  get("drop").onpaste = action(async event => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    await capture(files, []);
  });
  (options.mount ?? document.body).append(root);
  return { dispose() { disposed = true; root.remove(); } };
}

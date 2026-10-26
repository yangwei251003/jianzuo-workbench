import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Page = "login" | "listing-create" | "messages" | "orders" | "delivery";

function App() {
  const [page, setPage] = useState<Page>(() => localStorage.getItem("mock-logged-in") ? "listing-create" : "login");
  const [verification, setVerification] = useState(false);
  return <div className="mock-shell" data-jianzuo-page={page}>
    <header><div><span className="mock-logo">闲</span><strong>模拟闲鱼</strong><b>简作训练站</b>{page !== "login" && <a href="/personal" aria-label="简作测试账号">简作测试账号</a>}</div><nav>{([['listing-create','发布商品'],['messages','消息'],['orders','订单'],['delivery','交付']] as const).map(([value,label]) => <button key={value} className={page === value ? "active" : ""} onClick={() => setPage(value)} disabled={!localStorage.getItem("mock-logged-in")}>{label}</button>)}</nav><label><input type="checkbox" checked={verification} onChange={(event) => setVerification(event.target.checked)} />模拟验证</label></header>
    {verification && <div className="verification" data-verification-required="true"><strong>请完成安全验证</strong><span>这是测试状态。扩展必须立即停止，不得尝试绕过。</span><button onClick={() => setVerification(false)}>人工完成验证</button></div>}
    <main>
      {page === "login" && <Login onLogin={() => { localStorage.setItem("mock-logged-in", "1"); setPage("listing-create"); }} />}
      {page === "listing-create" && <Listing />}
      {page === "messages" && <Messages />}
      {page === "orders" && <Orders />}
      {page === "delivery" && <Delivery />}
    </main>
    <footer>本页面只用于本地自动化训练，不连接闲鱼服务器。</footer>
  </div>;
}

function Login({ onLogin }: { onLogin: () => void }) {
  return <section className="login-card"><div className="fake-qr" aria-label="模拟二维码">{Array.from({ length: 49 }, (_, index) => <i key={index} className={index % 3 === 0 || index % 7 === 1 ? "on" : ""} />)}</div><h1>扫码登录模拟闲鱼</h1><p>点击按钮模拟手机扫码确认。不会读取真实账号。</p><button data-action="confirm-login" onClick={onLogin}>模拟扫码成功</button></section>;
}

function Listing() {
  const [published, setPublished] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  return <section className="mock-card listing-card"><div className="page-title"><div><span>发布</span><h1>发布闲置</h1><p>模拟页面使用稳定测试标记；真实页面必须重新校准适配器。</p></div><b>草稿自动保存</b></div>
    <form onSubmit={(event) => { event.preventDefault(); setPublished(true); }}>
      <label>标题<input data-jianzuo-field="title" placeholder="填写标题" maxLength={60} /></label>
      <label>描述<textarea data-jianzuo-field="description" placeholder="描述商品详情" rows={8} /></label>
      <label>价格<input data-jianzuo-field="price" placeholder="0.00" inputMode="decimal" /></label>
      <label>商品图片<input data-jianzuo-field="images" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => setImages(Array.from(event.target.files ?? []).map((file) => file.name))} /><span className="upload-zone">点击或由扩展上传图片</span>{images.length > 0 && <small>{images.join("、")}</small>}</label>
      <button data-jianzuo-action="publish" type="submit">确认发布</button>
    </form>
    {published && <div className="success-result" data-jianzuo-result="published"><strong>发布成功</strong><span>模拟商品编号 MOCK-{Date.now()}</span></div>}
  </section>;
}

function Messages() {
  const [messages, setMessages] = useState(["这张图里的字能换一下吗？今晚要。"]);
  const [reply, setReply] = useState("");
  return <section className="mock-card message-card" data-jianzuo-conversation-id="MOCK-CONV-001" data-jianzuo-buyer-public-id="MOCK-BUYER-001" data-jianzuo-product-id="MOCK-PRODUCT-001"><aside><strong>买家 7***2</strong><span>图片文字替换微调</span><p>这张图里的字能换一下吗？</p></aside><div><div className="chat-log">{messages.map((message,index) => <p key={`${message}-${index}`} className={index ? "seller" : "buyer"} data-jianzuo-last-inbound={index === 0 ? "true" : undefined}>{message}</p>)}</div><textarea data-jianzuo-field="reply" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="输入消息" /><button data-jianzuo-action="send-reply" onClick={() => { if (reply.trim()) { setMessages((items) => [...items, reply]); setReply(""); } }}>发送</button><span data-jianzuo-result="reply-sent" hidden={messages.length < 2}>消息已发送</span></div></section>;
}

function Orders() {
  return <section className="mock-card"><div className="page-title"><div><span>订单</span><h1>我卖出的</h1></div></div><table><thead><tr><th>订单</th><th>商品</th><th>买家</th><th>金额</th><th>状态</th></tr></thead><tbody><tr data-order-id="MOCK-001" data-jianzuo-order-id="MOCK-001" data-jianzuo-conversation-id="MOCK-CONV-001" data-jianzuo-buyer-public-id="MOCK-BUYER-001" data-jianzuo-product-id="MOCK-PRODUCT-001" data-jianzuo-order-amount="12.9" data-jianzuo-order-currency="CNY"><td>MOCK-001</td><td>图片文字替换微调</td><td>买家 7***2</td><td>12.9</td><td>待交付</td></tr></tbody></table></section>;
}

function Delivery() {
  const [sent, setSent] = useState(false);
  return <section className="mock-card delivery-card" data-jianzuo-order-id="MOCK-001" data-jianzuo-conversation-id="MOCK-CONV-001" data-jianzuo-buyer-public-id="MOCK-BUYER-001" data-jianzuo-product-id="MOCK-PRODUCT-001" data-jianzuo-order-amount="12.9" data-jianzuo-order-currency="CNY"><div className="page-title"><div><span>交付</span><h1>发送数字商品</h1></div></div><label>附件<input data-jianzuo-field="delivery-file" type="file" /><span className="upload-zone">选择 ZIP 交付包</span></label><label>补充说明<textarea data-jianzuo-field="delivery-message" rows={5} placeholder="写明文件、版本和售后范围" /></label><button data-jianzuo-action="send-delivery" onClick={() => setSent(true)}>确认发送</button>{sent && <div className="success-result" data-jianzuo-result="delivery-sent"><strong>交付已发送</strong></div>}</section>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MagnifyingGlass, SlidersHorizontal } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { Product, ProductCategory } from "@jianzuo/contracts";
import { api, formatMoney } from "../api";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusPill } from "../components/ui";

const CATEGORIES: Array<"全部" | ProductCategory> = ["全部", "图片", "办公", "安装", "工具", "前端"];

export function ProductsPage() {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("全部");
  const [search, setSearch] = useState("");
  const query = useQuery({ queryKey: ["products"], queryFn: async () => (await api<Product[]>("/api/products")).data! });
  const products = useMemo(() => (query.data ?? []).filter((product) => (category === "全部" || product.category === category) && product.name.toLowerCase().includes(search.trim().toLowerCase())), [query.data, category, search]);

  return <div className="page-stack">
    <PageHeader eyebrow="首发商品计划" title="商品库" description="24 个数字服务商品。价格底线、修改次数与 14 天排期已经固化。" actions={<Link className="button button-primary button-normal" to="/content">进入内容工厂 <ArrowRight /></Link>} />
    <Panel className="flush-panel">
      <div className="table-toolbar"><div className="search-box"><MagnifyingGlass size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索商品" aria-label="搜索商品" /></div><div className="category-tabs" role="tablist" aria-label="商品分类">{CATEGORIES.map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div><span className="result-count"><SlidersHorizontal /> {products.length} 项</span></div>
      {query.isLoading ? <LoadingState label="正在读取商品库" /> : query.error ? <ErrorState message={query.error.message} retry={() => void query.refetch()} /> : !products.length ? <EmptyState title="没有匹配商品" description="换一个关键词或分类试试。" /> : <div className="table-scroll"><table className="data-table products-table"><thead><tr><th>商品</th><th>分类</th><th>三档价格</th><th>最低成交价</th><th>发布日</th><th>准备状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{products.map((product) => <tr key={product.id}><td><div className="product-cell"><span className={`category-symbol category-${product.category}`}>{product.name.slice(0, 1)}</span><div><strong>{product.name}</strong><small>{product.remoteService ? "人工远程服务" : "数字商品 / 定制服务"}</small></div></div></td><td>{product.category}</td><td><span className="price-text">{product.prices.map(formatMoney).join(" / ")}</span></td><td>{product.prices.map((price) => formatMoney(Math.round(price * 90) / 100)).join(" / ")}</td><td>第 {product.releaseDay} 天</td><td><StatusPill tone={product.readiness === "PUBLISHED" ? "success" : product.readiness === "CONTENT_READY" || product.readiness === "READY_TO_PUBLISH" ? "blue" : "neutral"}>{readinessLabel(product.readiness)}</StatusPill></td><td><Link className="row-action" to={`/content/${product.id}`}>策划 <ArrowRight /></Link></td></tr>)}</tbody></table></div>}
    </Panel>
  </div>;
}

function readinessLabel(status: Product["readiness"]): string {
  return ({ PLANNED: "待策划", CONTENT_READY: "内容就绪", READY_TO_PUBLISH: "可发布", PUBLISHED: "已发布" } as const)[status];
}

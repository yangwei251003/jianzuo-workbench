import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import sharp from "sharp";
import type { ContentBundle, Product } from "@jianzuo/contracts";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function safePath(root: string, ...parts: string[]): string {
  const output = resolve(root, ...parts);
  const prefix = `${resolve(root)}${sep}`;
  if (!output.startsWith(prefix)) throw new Error("产物路径越界");
  return output;
}

function wrap(text: string, max = 18): string[] {
  const lines: string[] = [];
  const closing = /[，。；：！？、）》】\]}]/;
  let current = "";
  for (const char of text) {
    if (current.length >= max && !closing.test(char)) {
      lines.push(current);
      current = "";
    }
    current += char;
  }
  if (current) lines.push(current);
  return lines.slice(0, 5);
}

function textLines(lines: string[], x: number, y: number, size: number, color: string, gap = 1.4): string {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * size * gap}" font-size="${size}" fill="${color}" font-family="Microsoft YaHei UI, sans-serif">${xml(line)}</text>`).join("\n");
}

function frame(title: string, kicker: string, body: string, price?: string): string {
  const titleLines = wrap(title, 12).slice(0, 2);
  const titleSize = titleLines.length > 1 ? 47 : 56;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <rect width="1200" height="1200" fill="#F3F6F9"/>
  <rect x="56" y="56" width="1088" height="1088" rx="28" fill="#FFFFFF" stroke="#D9E2EC" stroke-width="3"/>
  <rect x="56" y="56" width="1088" height="246" rx="28" fill="#102A43"/>
  <rect x="56" y="274" width="1088" height="28" fill="#102A43"/>
  <text x="104" y="126" font-size="28" fill="#BFD2E4" font-family="Microsoft YaHei UI, sans-serif">${xml(kicker)}</text>
  ${textLines(titleLines, 104, 197, titleSize, "#FFFFFF", 1.12)}
  ${price ? `<rect x="870" y="104" width="214" height="86" rx="16" fill="#F4B740"/><text x="977" y="161" text-anchor="middle" font-size="34" font-weight="700" fill="#0B1F33" font-family="Microsoft YaHei UI, sans-serif">${xml(price)}</text>` : ""}
  ${body}
  <line x1="104" y1="1086" x2="1096" y2="1086" stroke="#D9E2EC" stroke-width="2"/>
  <text x="104" y="1124" font-size="24" fill="#627D98" font-family="Microsoft YaHei UI, sans-serif">简作数字工作室 · 先看材料，再确认范围</text>
  </svg>`;
}

function caseVisual(product: Product, bundle: ContentBundle): string {
  const categoryLabels: Record<Product["category"], [string, string]> = {
    图片: ["原始素材", "处理结果"],
    工具: ["输入与设置", "本地工具输出"],
    安装: ["环境与报错", "人工检查结果"],
    办公: ["原始文档", "整理后版面"],
    前端: ["内容与素材", "响应式页面"]
  };
  const [inputLabel, outputLabel] = categoryLabels[product.category];
  const briefLines = wrap(bundle.imagePlan[1].brief.replace(/“|”/g, ""), 24).slice(0, 3);
  return `<rect x="104" y="320" width="430" height="340" rx="24" fill="#F3F6F9" stroke="#CBD8E5" stroke-width="3"/>
    <rect x="666" y="320" width="430" height="340" rx="24" fill="#EAF4EE" stroke="#B8D8C3" stroke-width="3"/>
    <text x="319" y="382" text-anchor="middle" font-size="28" font-weight="700" fill="#627D98" font-family="Microsoft YaHei UI, sans-serif">${xml(inputLabel)}</text>
    <text x="881" y="382" text-anchor="middle" font-size="28" font-weight="700" fill="#2F6B48" font-family="Microsoft YaHei UI, sans-serif">${xml(outputLabel)}</text>
    <rect x="166" y="430" width="306" height="24" rx="12" fill="#AFC2D4"/><rect x="166" y="486" width="238" height="24" rx="12" fill="#CBD8E5"/><rect x="166" y="542" width="274" height="24" rx="12" fill="#CBD8E5"/>
    <rect x="728" y="418" width="306" height="62" rx="14" fill="#FFFFFF"/><circle cx="766" cy="449" r="13" fill="#47A76A"/><rect x="794" y="438" width="198" height="22" rx="11" fill="#B8D8C3"/>
    <rect x="728" y="506" width="306" height="62" rx="14" fill="#FFFFFF"/><circle cx="766" cy="537" r="13" fill="#47A76A"/><rect x="794" y="526" width="168" height="22" rx="11" fill="#B8D8C3"/>
    <path d="M566 470h64l-20-20m20 20-20 20" fill="none" stroke="#F4B740" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
    ${textLines(briefLines, 128, 760, 29, "#486581", 1.55)}
    <text x="128" y="930" font-size="25" fill="#829AB1" font-family="Microsoft YaHei UI, sans-serif">结构示意 · 实际结果以买家材料和确认范围为准</text>`;
}

export type RenderedArtifact = { kind: string; path: string; sha256: string };
export const PRODUCT_IMAGE_FILES = [
  "01_品牌封面.png", "02_案例效果.png", "03_价格与范围.png", "04_服务流程.png", "05_材料清单.png", "06_修改与售后.png"
] as const;

export async function renderProductImages(_rootDir: string, dataDir: string, product: Product, bundle: ContentBundle, version: number): Promise<RenderedArtifact[]> {
  const outputDir = safePath(dataDir, "artifacts", "products", product.slug, `v${version}`);
  mkdirSync(outputDir, { recursive: true });
  const outputs: Array<{ name: string; kind: string; content: string }> = [];

  const coverBody = `${textLines(["适合改动明确、材料齐全的需求", "基础档起步，复杂内容看完再报价"], 104, 400, 38, "#243B53", 1.7)}
    <rect x="104" y="640" width="992" height="230" rx="20" fill="#EAF0F6"/>
    ${textLines(["先看材料", "确认范围", "按平台流程下单"], 150, 718, 36, "#102A43", 1.7)}`;
  outputs.push({ name: "01_品牌封面.png", kind: "cover", content: frame(product.name, product.category, coverBody, `${product.prices[0]} 元起`) });

  outputs.push({ name: "02_案例效果.png", kind: "case", content: frame("效果结构示意", product.name, caseVisual(product, bundle)) });

  const priceRows = bundle.priceTiers.map((tier, index) => {
    const y = 370 + index * 190;
    return `<rect x="104" y="${y}" width="992" height="150" rx="18" fill="${index === 1 ? "#FFF7E0" : "#F3F6F9"}"/>
      <text x="146" y="${y + 58}" font-size="36" font-weight="700" fill="#102A43" font-family="Microsoft YaHei UI, sans-serif">${tier.name}</text>
      <text x="1038" y="${y + 58}" text-anchor="end" font-size="40" font-weight="700" fill="#B7791F" font-family="Microsoft YaHei UI, sans-serif">${tier.price} 元</text>
      <text x="146" y="${y + 108}" font-size="25" fill="#486581" font-family="Microsoft YaHei UI, sans-serif">${xml(tier.scope)} · ${tier.revisions} 次同范围修改</text>`;
  }).join("\n");
  outputs.push({ name: "03_价格与范围.png", kind: "pricing", content: frame("三档价格与范围", product.name, priceRows) });

  const process = ["01  发送材料", "02  确认范围与价格", "03  制作并检查", "04  平台内交付", "05  同范围修改"];
  outputs.push({ name: "04_服务流程.png", kind: "process", content: frame("服务流程", product.name, textLines(process, 132, 370, 40, "#243B53", 1.8)) });

  const materials = bundle.materials.slice(0, 5).map((item, index) => `${index + 1}. ${item.label}${item.required ? "（必需）" : "（可选）"}`);
  outputs.push({ name: "05_材料清单.png", kind: "materials", content: frame("需要准备的材料", product.name, textLines(materials, 132, 370, 38, "#243B53", 1.85)) });

  const afterSales = ["基础 / 标准 / 进阶：1 / 2 / 3 次同范围修改", "需求方向变化，需要重新确认价格", "退款、投诉和验证由人工处理", "不接侵权、破解、凭证造假或非法代理", "原客户文件默认保留 30 天"];
  outputs.push({ name: "06_修改与售后.png", kind: "after_sales", content: frame("修改、售后与禁接范围", product.name, textLines(afterSales.flatMap((line) => wrap(line, 22)), 112, 350, 31, "#243B53", 1.55)) });

  const rendered: RenderedArtifact[] = [];
  for (const item of outputs) {
    const path = safePath(outputDir, item.name);
    await sharp(Buffer.from(item.content, "utf8")).png({ compressionLevel: 9 }).toFile(path);
    const bytes = readFileSync(path);
    rendered.push({ kind: item.kind, path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return rendered;
}

export function artifactFileName(path: string): string { return basename(path); }

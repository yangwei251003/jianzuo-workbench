import type { ProductCategory } from "@jianzuo/contracts";

export type ProductSeed = {
  slug: string;
  category: ProductCategory;
  name: string;
  prices: [number, number, number];
  releaseDay: number;
  remoteService?: boolean;
};

export const PRODUCT_SEEDS: ProductSeed[] = [
  { slug: "image-text-edit", category: "图片", name: "图片文字替换微调", prices: [4.9, 12.9, 29.9], releaseDay: 1 },
  { slug: "background-cutout", category: "图片", name: "抠图换背景与透明底", prices: [4.9, 12.9, 29.9], releaseDay: 1 },
  { slug: "portrait-retouch", category: "图片", name: "自然人像精修", prices: [9.9, 29.9, 59.9], releaseDay: 3 },
  { slug: "authorized-cleanup", category: "图片", name: "授权图片水印与杂物清理", prices: [4.9, 19.9, 39.9], releaseDay: 5 },
  { slug: "ecommerce-key-visual", category: "图片", name: "电商主图与卖点图", prices: [19.9, 49.9, 99], releaseDay: 7 },
  { slug: "campaign-poster", category: "图片", name: "活动与宣传海报", prices: [19.9, 49.9, 99], releaseDay: 8 },
  { slug: "ai-custom-image", category: "图片", name: "按需 AI 定制生图", prices: [9.9, 29.9, 69.9], releaseDay: 9 },
  { slug: "batch-image-style", category: "图片", name: "批量图片统一风格", prices: [19.9, 49.9, 99], releaseDay: 10 },
  { slug: "local-resume-builder", category: "工具", name: "本地简历生成器", prices: [19.9, 49.9, 99], releaseDay: 10 },
  { slug: "local-pdf-toolkit", category: "工具", name: "本地 PDF 工具箱", prices: [19.9, 49.9, 99], releaseDay: 11 },
  { slug: "desktop-file-organizer", category: "工具", name: "桌面文件自动整理器", prices: [19.9, 49.9, 99], releaseDay: 11 },
  { slug: "web-mini-games", category: "工具", name: "多款轻量网页小游戏", prices: [9.9, 29.9, 79.9], releaseDay: 12 },
  { slug: "original-agent-skills", category: "工具", name: "原创 Agent Skill 数字包", prices: [29.9, 79.9, 199], releaseDay: 14 },
  { slug: "codex-cli-setup", category: "安装", name: "Codex CLI 安装配置", prices: [29.9, 59.9, 99], releaseDay: 6, remoteService: true },
  { slug: "openclaw-setup", category: "安装", name: "OpenClaw 本地安装", prices: [39.9, 79.9, 129], releaseDay: 12, remoteService: true },
  { slug: "docker-compose-setup", category: "安装", name: "Docker 与 Compose 环境", prices: [29.9, 59.9, 99], releaseDay: 8, remoteService: true },
  { slug: "remote-troubleshooting", category: "安装", name: "远程软件故障排查", prices: [29.9, 59.9, 99], releaseDay: 2, remoteService: true },
  { slug: "ppt-polish", category: "办公", name: "PPT 美化与统一排版", prices: [9.9, 49.9, 99], releaseDay: 2 },
  { slug: "excel-formula", category: "办公", name: "Excel 公式修复与设计", prices: [19.9, 39.9, 79.9], releaseDay: 3 },
  { slug: "excel-clean-merge", category: "办公", name: "Excel 数据清洗与合并", prices: [19.9, 49.9, 99], releaseDay: 4 },
  { slug: "word-long-format", category: "办公", name: "Word 长文档排版", prices: [19.9, 49.9, 99], releaseDay: 4 },
  { slug: "resume-layout", category: "办公", name: "简历排版与版面优化", prices: [19.9, 39.9, 69.9], releaseDay: 5 },
  { slug: "portfolio-page", category: "前端", name: "个人主页与作品集单页", prices: [99, 299, 499], releaseDay: 13 },
  { slug: "static-site-deploy", category: "前端", name: "静态网站部署上线", prices: [69.9, 129, 249], releaseDay: 13 }
];


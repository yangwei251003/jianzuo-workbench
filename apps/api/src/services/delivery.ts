import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { ZipArchive } from "archiver";
import { licenseCanPublish, productNeedsLicenseReview } from "@jianzuo/core";

function within(root: string, ...parts: string[]): string {
  const output = resolve(root, ...parts);
  if (!output.startsWith(`${resolve(root)}${sep}`)) throw new Error("交付路径越界");
  return output;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\.\./g, "_").trim();
  if (!safe) throw new Error("文件名无效");
  return safe.slice(0, 80);
}

export type PackageResult = { zipPath: string; packageDir: string; sha256: string; files: string[] };

export async function buildDeliveryPackage(dataDir: string, order: Record<string, unknown>): Promise<PackageResult> {
  const orderId = safeSegment(String(order.id));
  const productName = safeSegment(String(order.product_name));
  const productCategory = String(order.product_category ?? order.category ?? "") as "图片" | "工具" | "安装" | "办公" | "前端";
  const licenseReview = String(order.license_review ?? "").trim();
  if (!orderId.startsWith("DEMO-") && productNeedsLicenseReview({ category: productCategory })) {
    const gate = licenseCanPublish(licenseReview);
    if (!gate.allowed) throw new Error(`许可证审查未通过：${gate.reason}`);
  }
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const orderRoot = within(dataDir, "artifacts", "orders", orderId);
  mkdirSync(orderRoot, { recursive: true });
  const priorVersions = readdirSync(orderRoot).map((name) => Number(name.match(/_v(\d+)_\d{8}(?:\.zip)?$/)?.[1] ?? 0));
  const version = Math.max(0, ...priorVersions) + 1;
  const packageName = `${productName}_v${version}_${date}`;
  const packageDir = within(orderRoot, packageName);
  mkdirSync(packageDir, { recursive: true });

  const dirs = [
    "01_成品或程序", "02_使用说明_README", "03_安装与启动方法", "04_常见问题_FAQ",
    "05_LICENSE与原作者声明", "06_二次修改说明", "07_版本记录与售后范围"
  ];
  dirs.forEach((dir) => mkdirSync(within(packageDir, dir), { recursive: true }));
  const workDir = within(orderRoot, "work");
  const workFiles = existsSync(workDir) ? walkFiles(workDir) : [];
  if (!workFiles.length && !orderId.startsWith("DEMO-")) throw new Error("成品目录为空，请先完成制作并把成果放入订单 work 目录");
  if (!workFiles.length) {
    writeFileSync(within(packageDir, "01_成品或程序", "DEMO_示例成品.txt"), "这是模拟订单的测试成品，不会发送给真实买家。\n", "utf8");
  } else {
    for (const source of workFiles) {
      const target = within(packageDir, "01_成品或程序", relative(workDir, source));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
  writeFileSync(within(packageDir, "02_使用说明_README", "README.txt"), `${productName}\n\n订单：${orderId}\n请先阅读安装与启动方法。\n`, "utf8");
  writeFileSync(within(packageDir, "03_安装与启动方法", "启动说明.txt"), "请先完整解压，再从 01_成品或程序 查看成果；如包含程序，按随附说明启动。\n", "utf8");
  writeFileSync(within(packageDir, "04_常见问题_FAQ", "FAQ.txt"), "文件打不开：请先完整解压，再按启动说明操作。\n需要修改：请在已确认范围内说明具体位置。\n", "utf8");
  const licenseStatement = orderId.startsWith("DEMO-")
    ? "模拟交付包不包含第三方项目，仅用于本地链路测试。\n"
    : productNeedsLicenseReview({ category: productCategory })
      ? `本次许可证核验：${licenseReview}\n已确认保留成品内的第三方许可证、NOTICE 与原作者声明；不得删除或改写。\n`
      : "本次交付为服务成果；如成品包含第三方素材或依赖，以随附许可证和原作者声明为准，不得移除。\n";
  writeFileSync(within(packageDir, "05_LICENSE与原作者声明", "LICENSE说明.txt"), licenseStatement, "utf8");
  writeFileSync(within(packageDir, "06_二次修改说明", "修改说明.txt"), `套餐：${String(order.tier)}\n同范围修改次数：${String(order.revision_limit)}\n`, "utf8");
  writeFileSync(within(packageDir, "07_版本记录与售后范围", "版本记录.txt"), `v${version} ${new Date().toISOString()} 交付包\n售后只覆盖已确认范围。\n`, "utf8");

  const files = walkFiles(packageDir).filter((path) => !path.endsWith("SHA256SUMS.txt"));
  const sums = files.map((path) => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${path.slice(packageDir.length + 1).replaceAll("\\", "/")}`).join("\n");
  writeFileSync(within(packageDir, "SHA256SUMS.txt"), `${sums}\n`, "utf8");
  const allFiles = walkFiles(packageDir);
  const zipPath = within(orderRoot, `${packageName}.zip`);
  if (!existsSync(zipPath)) await zipDirectory(packageDir, zipPath);
  const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  return { zipPath, packageDir, sha256, files: allFiles.map((path) => path.slice(packageDir.length + 1).replaceAll("\\", "/")) };
}

function walkFiles(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = within(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("交付目录中不允许符号链接");
    if (stat.isDirectory()) output.push(...walkFiles(path));
    else if (stat.isFile()) output.push(path);
  }
  return output.sort();
}

async function zipDirectory(source: string, destination: string): Promise<void> {
  if (existsSync(destination)) throw new Error(`交付包已存在：${basename(destination)}`);
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(destination, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", resolvePromise);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(source, false);
    void archive.finalize();
  });
}

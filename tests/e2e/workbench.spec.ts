import { expect, test, type Page } from "@playwright/test";

const TEST_PIN = "246810";

async function unlock(page: Page) {
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "设置本地 PIN" });
  if (await setup.isVisible().catch(() => false)) {
    const passwords = page.locator('input[type="password"]');
    await passwords.nth(0).fill(TEST_PIN);
    await passwords.nth(1).fill(TEST_PIN);
    await page.getByRole("button", { name: "完成设置" }).click();
  } else if (await page.getByRole("heading", { name: "解锁简作工作台" }).isVisible().catch(() => false)) {
    await page.locator('input[type="password"]').fill(TEST_PIN);
    await page.getByRole("button", { name: "解锁工作台" }).click();
  }
  await expect(page.getByRole("heading", { name: "经营总览" })).toBeVisible();
}

test.beforeEach(async ({ page }) => unlock(page));

test("24 个商品和安全边界可见", async ({ page }) => {
  await page.getByRole("link", { name: "商品库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "商品库" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(24);
  await expect(page.getByText("图片文字替换微调", { exact: true })).toBeVisible();
  await expect(page.getByText("¥4.9 / ¥12.9 / ¥29.9", { exact: true }).first()).toBeVisible();
});

test("批量准备逐项显示失败且失败商品保持未就绪", async ({ page }) => {
  const products = await page.evaluate(async () => {
    const response = await fetch("/api/products", { credentials: "include" });
    return (await response.json()).data as Array<{ id: string; name: string }>;
  });
  const failedProduct = products[0]!;
  await page.route("**/api/content/prepare-all", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "needs_user",
        summary: "已准备 23 个商品，1 个未完成",
        data: {
          total: products.length,
          readyBefore: 0,
          pendingBefore: products.length,
          readyAfter: products.length - 1,
          pendingAfter: 1,
          generated: products.length - 1,
          failed: 1,
          items: products.map((product, index) => ({
            productId: product.id,
            productName: product.name,
            outcome: index === 0 ? "failed" : "generated",
            ready: index !== 0,
            summary: index === 0 ? "六图模板生成不完整" : "白描文案与六图模板已准备",
            ...(index === 0 ? {} : { version: 1 }),
            issues: index === 0 ? ["六图模板生成不完整"] : [],
            artifactCount: index === 0 ? 0 : 6
          }))
        },
        nextActions: [{ type: "review_failed_content", label: "查看未完成项目" }],
        artifacts: [],
        correlationId: "e2e-partial-content"
      })
    });
  });

  await page.getByRole("link", { name: "内容工厂" }).click();
  await page.getByRole("button", { name: /一键准备剩余/ }).click();
  await expect(page.getByText("批量准备已结束，仍有未完成项目")).toBeVisible();
  const failedRow = page.locator(".content-batch-results article.failed").filter({ hasText: failedProduct.name });
  await expect(failedRow).toContainText("未就绪");
  await expect(failedRow).toContainText("六图模板生成不完整");
  await expect(failedRow).not.toContainText(/v\d+ · 六图/);
});

test("一键准备 24 个商品的白描文案和六图模板", async ({ page }) => {
  test.setTimeout(120_000);
  await page.getByRole("link", { name: "内容工厂" }).click();
  await expect(page.getByRole("heading", { name: "24 个商品内容包" })).toBeVisible();
  await page.getByRole("button", { name: /一键准备剩余/ }).click();
  await expect(page.getByText("批量准备已完成")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("content-ready-count")).toHaveText("24");
  await expect(page.getByTestId("content-pending-count")).toHaveText("0");
  await expect(page.getByRole("button", { name: "检查并补齐全部内容" })).toBeEnabled();
  const publicationState = await page.evaluate(async () => {
    const response = await fetch("/api/publications", { credentials: "include" });
    return (await response.json()).data as { publications: unknown[]; actions: unknown[] };
  });
  expect(publicationState.publications).toHaveLength(0);
  expect(publicationState.actions).toHaveLength(0);
  await page.screenshot({ path: "output/playwright/content-batch-1440.png", fullPage: true });
  await page.getByText("查看 24 个商品的逐项结果").click();
  await expect(page.locator(".content-batch-results article")).toHaveCount(24);
  await expect(page.locator(".content-batch-results article.failed")).toHaveCount(0);
  await page.getByRole("button", { name: "六张商品图" }).click();
  await expect(page.locator(".image-plan-grid article")).toHaveCount(6);
  await expect(page.locator(".image-plan-grid img")).toHaveCount(6);
});

test("生成白描文案与六图并进入模拟发布", async ({ page }) => {
  await page.getByRole("link", { name: "内容工厂" }).click();
  await page.getByLabel("当前商品").selectOption({ label: "图片 · 图片文字替换微调" });
  await page.getByRole("button", { name: /生成完整内容|生成新版本/ }).first().click();
  await expect(page.getByText("校验通过")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "六张商品图" }).click();
  await expect(page.locator(".image-plan-grid article")).toHaveCount(6);
  await expect(page.getByAltText("图片文字替换微调·案例效果")).toBeVisible();
  expect(await page.locator(".image-plan-grid img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth === 1200))).toBe(true);

  await page.getByRole("link", { name: "发布中心" }).click();
  await page
    .getByLabel("选择内容就绪商品")
    .selectOption({ label: "第 1 天 · 图片文字替换微调" });
  await page.getByText("批准后立即执行本次模拟").click();
  await page.getByRole("button", { name: "预检并进入审批" }).click();
  await expect(page.getByText("发布动作已准备，等待人工审批")).toBeVisible();
  await page.getByRole("button", { name: "批准" }).first().click();
  await expect(page.getByText("已发布").first()).toBeVisible({ timeout: 12_000 });
});

test("结果未知动作被封存且不重放", async ({ page }) => {
  await page.getByRole("link", { name: "内容工厂" }).click();
  await page.getByLabel("当前商品").selectOption({ label: "图片 · 抠图换背景与透明底" });
  await page.getByRole("button", { name: /生成完整内容|生成新版本/ }).first().click();
  await expect(page.getByText("校验通过")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: "发布中心" }).click();
  await page
    .getByLabel("选择内容就绪商品")
    .selectOption({ label: "第 1 天 · 抠图换背景与透明底" });
  await page.getByText("批准后立即执行本次模拟").click();
  await page.getByText("模拟“结果未知”异常").click();
  await page.getByRole("button", { name: "预检并进入审批" }).click();
  await page.getByRole("button", { name: "批准" }).first().click();
  await expect(page.getByText("禁止重放").first()).toBeVisible({ timeout: 12_000 });
});

test("订单同意、数字打包、审批交付和窄窗口可用", async ({ page }) => {
  await page.getByRole("link", { name: "订单与交付" }).click();
  const digitalOrder = page.getByRole("row").filter({ hasText: /DEMO-.*-003/ });
  await expect(digitalOrder).toBeVisible();
  await digitalOrder.click();
  await page.getByText("我已向买家展示告知，并取得单独明确同意").click();
  await page.getByRole("button", { name: "记录同意" }).click();
  await page.getByRole("button", { name: "生成并校验 ZIP" }).click();
  await expect(page.getByText("交付包已生成并通过校验")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "开始制作" })).toBeVisible();
  await page.getByRole("button", { name: "开始制作" }).click();
  await expect(page.getByRole("button", { name: "提交审阅" })).toBeVisible();
  await page.getByRole("button", { name: "提交审阅" }).click();
  await expect(page.getByRole("button", { name: "确认可交付" })).toBeVisible();
  await page.getByRole("button", { name: "确认可交付" }).click();
  await expect(page.getByRole("button", { name: "准备发送" })).toBeVisible();
  await page.getByRole("button", { name: "准备发送" }).click();
  await expect(page.getByText("交付动作已准备，等待人工审批")).toBeVisible();
  await page.getByRole("button", { name: "批准并发送" }).click();
  await expect(digitalOrder).toContainText("已交付", { timeout: 12_000 });
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开导航" })).toBeVisible();
});

test("远程服务只保存授权、动作和结果摘要", async ({ page }) => {
  await page.getByRole("link", { name: "订单与交付" }).click();
  const remoteOrder = page.getByRole("row").filter({ hasText: /DEMO-.*-002/ });
  await expect(remoteOrder).toBeVisible();
  await remoteOrder.click();
  await page.getByLabel("动作摘要").fill("检查官方安装包日志，修复环境变量后重新启动");
  await page.getByLabel("处理结果").fill("官方软件已正常启动，已告知买家后续更新方法");
  await page.getByRole("button", { name: "保存人工结果" }).click();
  await expect(page.getByText("人工远程服务记录已保存")).toBeVisible();
  await expect(page.getByText(/最近记录：官方软件已正常启动/)).toBeVisible();
});

test("真实经营与演示数据分区并生成本地日报", async ({ page }) => {
  await page.getByRole("link", { name: "经营分析" }).click();
  await expect(page.getByRole("heading", { name: "真实经营漏斗" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "演示与模拟数据" })).toBeVisible();
  await expect(page.locator(".source-comparison").getByText("3", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "生成今日日报" }).click();
  await expect(page.getByText(/今天尚未记录真实闲鱼页面指标|已记录 \d+ 份真实可见页面快照/)).toBeVisible();
});

test("1440 与 1280 视觉快照", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.screenshot({ path: "output/playwright/dashboard-1440.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/products");
  await page.screenshot({ path: "output/playwright/products-1280.png", fullPage: true });
});

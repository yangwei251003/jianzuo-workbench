import type { ContentBundle, ImageBrief, MaterialRequirement, PriceTier, Product } from "@jianzuo/contracts";
import { floorPrice, hardHandoffReason, normalizeFaqQuestion, productNeedsLicenseReview } from "./policy.js";

const TIER_NAMES = ["基础", "标准", "进阶"] as const;
const REVISIONS = [1, 2, 3] as const;

const CATEGORY_MATERIALS: Record<Product["category"], MaterialRequirement[]> = {
  图片: [
    { id: "source", label: "原图或原文件", required: true, description: "尽量发送清晰原图，不要先压缩。", acceptedTypes: ["jpg", "png", "psd", "zip"] },
    { id: "target", label: "想改成的样子", required: true, description: "可用文字说明，也可发参考图。" },
    { id: "usage", label: "使用场景和尺寸", required: true, description: "说明发布平台、比例或像素要求。" },
    { id: "rights", label: "素材权利说明", required: true, description: "确认对图片和其中内容拥有处理授权。" }
  ],
  工具: [
    { id: "os", label: "电脑系统", required: true, description: "Windows 版本或其他目标环境。" },
    { id: "workflow", label: "实际使用流程", required: true, description: "列出输入、处理和期望输出。" },
    { id: "sample", label: "脱敏样例", required: false, description: "提供不含隐私的样例文件便于确认。" }
  ],
  安装: [
    { id: "os", label: "系统版本", required: true, description: "系统版本、架构和当前权限。" },
    { id: "error", label: "报错原文", required: false, description: "截图或复制完整报错，不要只说装不上。" },
    { id: "consent", label: "远程操作授权", required: true, description: "远控前单独确认范围和时间；不要发送密码或远控码。" }
  ],
  办公: [
    { id: "source", label: "原始文档", required: true, description: "请先自行备份，再发送可编辑文件。", acceptedTypes: ["pptx", "xlsx", "docx", "zip"] },
    { id: "style", label: "格式或参考样式", required: true, description: "说明学校、公司或发布场景的格式要求。" },
    { id: "deadline", label: "期望完成时间", required: true, description: "复杂文档需看页数和结构后确认。" }
  ],
  前端: [
    { id: "content", label: "页面文字和栏目", required: true, description: "先给出姓名、介绍、项目和联系方式等内容。" },
    { id: "style", label: "参考风格", required: false, description: "可发喜欢的网站截图或颜色偏好。" },
    { id: "assets", label: "图片与授权", required: true, description: "确认头像、作品图和字体等素材可用。" },
    { id: "deploy", label: "域名和部署环境", required: false, description: "如需上线，说明是否已有域名或平台账号。" }
  ]
};

export type ProductContentProfile = {
  summary: string;
  servicePoints: [string, string, ...string[]];
  tierScopes: [string, string, string];
  materials: MaterialRequirement[];
  caseBrief: string;
  deliveryChecks: [string, ...string[]];
  boundaries?: [string, ...string[]];
};

function material(
  id: string,
  label: string,
  required: boolean,
  description: string,
  acceptedTypes?: string[]
): MaterialRequirement {
  return { id, label, required, description, acceptedTypes };
}

/**
 * 首发商品的逐商品内容事实源。这里写服务范围，不写价格；价格、底价和修改次数
 * 始终从 Product 与经营规则计算，避免文案配置和实际标价各自漂移。
 */
export const PRODUCT_CONTENT_PROFILES: Record<string, ProductContentProfile> = {
  "image-text-edit": {
    summary: "替换图片里的少量文字，并尽量接回原来的字号、颜色和排版。",
    servicePoints: [
      "按旧文字与新文字对照表逐项替换",
      "处理文字覆盖后的简单底纹衔接",
      "按约定尺寸导出 JPG 或 PNG"
    ],
    tierScopes: [
      "1 张图、3 处以内文字替换，底图清楚",
      "1–3 张图、10 处以内替换，含字号、颜色和对齐微调",
      "多处文字或复杂底纹修补，先按标注位置确认工作量"
    ],
    materials: [
      material("source", "清晰原图", true, "发送未压缩的原图；有 PSD 时可一并提供。", ["jpg", "jpeg", "png", "psd", "zip"]),
      material("copy-map", "新旧文字对照", true, "按“原文字 → 新文字”列清楚，避免口头描述漏项。", ["txt", "docx", "xlsx", "jpg", "png"]),
      material("font", "字体或字体要求", false, "有指定字体请提供可用字体文件；没有时先确认相近字体。", ["ttf", "otf", "txt"]),
      material("output", "输出尺寸与用途", true, "说明像素、比例、文件格式和使用平台。"),
      material("rights", "内容与素材授权", true, "确认图片和拟修改文字可合法使用；不得用于伪造凭证。")
    ],
    caseBrief: "用自制菜单样张展示同一处文字替换前后，放大文字边缘和底纹衔接；标注“自制示意”，不使用客户图。",
    deliveryChecks: ["逐项核对新旧文字对照表", "检查错别字、对齐和文字边缘", "核对导出尺寸、色彩和文件格式"],
    boundaries: ["不修改证件、票据、成绩单、合同截图等可能用于造假的内容"]
  },
  "background-cutout": {
    summary: "把主体从原背景中分离，交付透明底或换成已确认的新背景。",
    servicePoints: [
      "保留主体完整轮廓并处理明显白边",
      "透明底使用 PNG 交付",
      "换背景时按目标尺寸调整主体位置"
    ],
    tierScopes: [
      "1 张、轮廓清楚的单个物体，交付透明底或纯色底",
      "1–3 张，含头发、毛绒或半透明边缘的细节处理",
      "多主体、复杂遮挡或多图统一背景，先看原图确认数量"
    ],
    materials: [
      material("source", "清晰原图", true, "主体边缘要完整，尽量发送原始分辨率。", ["jpg", "jpeg", "png", "tif", "zip"]),
      material("background", "目标背景", true, "说明透明底、纯色值，或提供有权使用的背景图。", ["jpg", "jpeg", "png", "txt"]),
      material("size", "成品尺寸", true, "说明比例、像素和是否需要留白。"),
      material("edge", "边缘保留要求", false, "说明头发、阴影、玻璃或毛绒是否要保留。"),
      material("rights", "素材授权", true, "确认主体图和背景图均可处理和使用。")
    ],
    caseBrief: "用自摄日用品做三栏示意：原背景、透明棋盘格、纯色新背景；展示边缘近看效果，不冒充客户案例。",
    deliveryChecks: ["在深浅两种底色上检查白边和漏抠", "确认透明通道、阴影和半透明边缘", "核对主体比例、位置和成品尺寸"]
  },
  "portrait-retouch": {
    summary: "在保留本人特征和皮肤质感的前提下，处理人像里的明显瑕疵、光色和杂乱细节。",
    servicePoints: [
      "先约定保留哪些个人特征",
      "处理临时瑕疵、肤色和局部明暗",
      "默认不做失真的脸型或五官改造"
    ],
    tierScopes: [
      "1 张单人半身照，做基础肤色和临时瑕疵调整",
      "1–3 张单人照片，含光色、皮肤和背景小杂物处理",
      "多人或复杂光线照片，按人数和精修区域确认范围"
    ],
    materials: [
      material("source", "人像原图", true, "发送本人或已获授权人物的清晰原图，不要先用滤镜压缩。", ["jpg", "jpeg", "png", "tif", "zip"]),
      material("retain", "需要保留的特征", true, "说明痣、纹理、肤色和脸型等哪些不能改。"),
      material("adjust", "希望调整的位置", true, "按脸部、皮肤、光线、背景分别列出。", ["txt", "jpg", "png"]),
      material("usage", "使用场景与尺寸", true, "说明证件照、社交头像或打印等实际用途。"),
      material("consent", "肖像授权确认", true, "确认本人同意处理；未成年人照片需监护人同意。")
    ],
    caseBrief: "使用 AI 生成的虚构成年人脸作教学示意，展示自然肤色与过度磨皮的区别；明确标注“虚构人物示意”。",
    deliveryChecks: ["对照原图确认人物身份特征未被擅自改变", "放大检查皮肤纹理、发丝和边缘", "检查肤色、亮度和不同屏幕下的观感"],
    boundaries: ["不制作冒充他人、欺骗身份或未经同意的人像内容"]
  },
  "authorized-cleanup": {
    summary: "只处理自有或明确获授权图片中的标记、灰尘、路人和小杂物。",
    servicePoints: [
      "开工前确认图片权利和需要清理的位置",
      "按标注区域修补背景纹理",
      "不把第三方版权标识当作普通杂物处理"
    ],
    tierScopes: [
      "1 张自有图片、1 处简单标记或杂物，背景较平整",
      "1–3 张或多处清理，含一般纹理衔接",
      "复杂重复纹理、遮挡主体或批量图片，先核验授权和工作量"
    ],
    materials: [
      material("source", "原始图片", true, "提供未压缩原图，避免二次压缩影响修补。", ["jpg", "jpeg", "png", "tif", "zip"]),
      material("marks", "清理位置标注", true, "在副本上圈出每一处要处理的内容。", ["jpg", "jpeg", "png", "pdf"]),
      material("rights", "权利或授权说明", true, "说明图片来源、权利人和允许修改的范围；无法确认时不接。", ["txt", "pdf", "jpg", "png"]),
      material("output", "输出要求", true, "说明尺寸、格式和是否保留原色。")
    ],
    caseBrief: "用自摄桌面照片演示清理灰尘和无关小物前后，标注“自有素材示意”；不展示第三方水印移除。",
    deliveryChecks: ["复核授权范围与标注区域一致", "检查修补处是否重复、糊边或误伤主体", "对照原图确认未改动未授权区域"],
    boundaries: ["第三方平台水印、摄影师署名、版权标识或来源不明图片一律不处理"]
  },
  "ecommerce-key-visual": {
    summary: "用买家提供的真实商品图、参数和卖点，排成可读的主图或卖点图。",
    servicePoints: [
      "先核对商品名称、参数和可证明的卖点",
      "中文文字使用本地排版，避免生成错字",
      "按目标平台尺寸交付可发布图片"
    ],
    tierScopes: [
      "1 张基础主图，使用现成商品图和已定文案",
      "1 张主图加 2 张卖点图，统一颜色和版式",
      "1 套最多 6 张主辅图，含信息层级和多尺寸适配"
    ],
    materials: [
      material("product-images", "商品原图", true, "提供清晰产品图、细节图和可用场景图。", ["jpg", "jpeg", "png", "psd", "zip"]),
      material("facts", "商品参数与卖点", true, "只写可核验的尺寸、材质、功能和使用限制。", ["txt", "docx", "xlsx", "pdf"]),
      material("brand", "品牌视觉资料", false, "提供有权使用的 Logo、色值和字体。", ["png", "svg", "ai", "psd", "pdf", "zip"]),
      material("platform", "平台与图片规格", true, "说明平台、画布比例、像素和安全边距。"),
      material("rights", "素材与宣传授权", true, "确认图片、商标和宣传文字均可用于销售页面。")
    ],
    caseBrief: "用自制无品牌纸盒和虚构参数排一张主图与一张卖点图，所有文字标注“版式示意”，不伪造销量或功效。",
    deliveryChecks: ["逐字核对商品参数和卖点来源", "检查字号、对比度和移动端可读性", "确认画布尺寸、Logo 安全区和导出清晰度"],
    boundaries: ["不编造销量、认证、对比结论、医疗功效或绝对化宣传"]
  },
  "campaign-poster": {
    summary: "把已确认的活动信息排成一张层级清楚、能直接核对的宣传海报。",
    servicePoints: [
      "先锁定活动名称、时间、地点和报名方式",
      "按主次关系整理标题、正文和行动信息",
      "二维码和联系方式只使用买家提供的最终版本"
    ],
    tierScopes: [
      "1 张单尺寸海报，文字和素材均已齐全",
      "1 个版式加 2 个常用尺寸适配，含一次信息校对",
      "同一活动最多 3 张系列海报，统一视觉和信息层级"
    ],
    materials: [
      material("copy", "最终活动文字", true, "列明名称、时间、地点、对象、费用和报名方式。", ["txt", "docx", "xlsx", "pdf"]),
      material("assets", "图片与品牌素材", true, "提供有权使用的照片、Logo、插画或背景。", ["jpg", "jpeg", "png", "svg", "ai", "psd", "zip"]),
      material("qr", "二维码与联系方式", false, "提供最终二维码原图，并说明链接用途。", ["png", "jpg", "jpeg", "svg"]),
      material("sizes", "发布渠道和尺寸", true, "说明打印、朋友圈、公众号或屏幕等尺寸。"),
      material("approval", "信息确认人", true, "指定最终核对活动信息的人，避免版本混用。")
    ],
    caseBrief: "为虚构的社区旧书交换日制作海报示意，日期、地址和二维码均明确写“示意信息”，不冒充真实活动。",
    deliveryChecks: ["逐项核对名称、日期、地点、费用和联系方式", "实际扫码检查二维码可读性", "检查打印出血或屏幕尺寸及字体授权"]
  },
  "ai-custom-image": {
    summary: "根据用途、主体、画面和禁用项生成定制图片，先用低清方向图确认再出成品。",
    servicePoints: [
      "把抽象想法拆成主体、环境、光线、构图和比例",
      "方向确认后再细化，不承诺完全复刻参考图",
      "需要准确中文时改用本地模板排字"
    ],
    tierScopes: [
      "1 个明确方向、1 张成品，含基础构图调整",
      "2 个方向草案、最多 3 张同主题成品",
      "一组统一主题图片，数量和连续性要求先确认"
    ],
    materials: [
      material("purpose", "图片用途", true, "说明头像、封面、海报底图、产品概念或其他用途。"),
      material("brief", "画面说明", true, "写清主体、动作、环境、构图、光线和必须出现的元素。", ["txt", "docx", "pdf"]),
      material("references", "参考方向", false, "可发构图或配色参考，不接受照搬具体作品或在世艺术家风格。", ["jpg", "jpeg", "png", "pdf", "zip"]),
      material("negative", "不要出现的内容", true, "列出禁用颜色、物体、文字和容易误解的元素。"),
      material("size", "比例与尺寸", true, "说明横竖版、比例、像素和文件格式。"),
      material("rights", "人物与品牌授权", true, "涉及真人、商标或受保护角色时说明授权情况。")
    ],
    caseBrief: "生成一组无品牌的安静书桌概念图，展示“需求拆解—方向草图—成品”的过程；不仿冒真实品牌或艺术家。",
    deliveryChecks: ["逐项核对主体、场景、构图和禁用项", "检查多图中的人物、物体和色调一致性", "核对尺寸，并排查错误文字、异常手部和多余元素"],
    boundaries: ["不生成冒充真人、未经同意的人脸、受保护角色仿制或违法内容"]
  },
  "batch-image-style": {
    summary: "先确认一张样图，再把一批图片按同一套颜色、裁切和导出规则处理。",
    servicePoints: [
      "先做 1 张样图锁定风格参数",
      "批量处理时保留原文件并按规则重命名",
      "无法统一处理的异常图单独列出"
    ],
    tierScopes: [
      "3 张以内，统一亮度、色温或固定比例中的一项",
      "10 张以内，统一色调、裁切和导出命名",
      "30 张以内，含样图确认、批处理和异常图清单"
    ],
    materials: [
      material("sources", "原图压缩包", true, "按顺序打包未压缩原图，并保留自己的备份。", ["zip", "jpg", "jpeg", "png", "tif"]),
      material("reference", "目标样式", true, "提供一张目标图或写清亮度、色温、饱和度和裁切方向。", ["jpg", "jpeg", "png", "txt"]),
      material("rules", "尺寸与命名规则", true, "说明统一尺寸、文件格式、质量和文件名格式。"),
      material("exceptions", "例外图片", false, "列出不能裁切主体或需要单独处理的文件名。"),
      material("rights", "素材授权", true, "确认整批图片均有权处理。")
    ],
    caseBrief: "用同一组自摄静物展示原图、确认样图和三张统一结果，并列出固定色温与裁切规则。",
    deliveryChecks: ["核对输入与输出文件数量", "抽查首张、末张和异常图的色调与裁切", "检查文件名、尺寸、格式及未处理清单"]
  },
  "local-resume-builder": {
    summary: "交付在本机运行的简历填写与导出工具，并把启动和数据保存位置写清楚。",
    servicePoints: [
      "只用脱敏示例数据演示字段和版式",
      "按目标电脑确认启动方式",
      "个人信息默认保存在买家自己的电脑上"
    ],
    tierScopes: [
      "交付当前基础版本、1 套版式和本地启动说明",
      "在现有结构上调整字段或配色，含常用导出检查",
      "增加约定字段、版式或本地打包方式，先确认兼容范围"
    ],
    materials: [
      material("os", "目标电脑环境", true, "说明 Windows 版本、浏览器和是否允许安装运行环境。"),
      material("fields", "简历字段清单", true, "只写需要哪些栏目；真实个人内容可在工具交付后自行填写。", ["txt", "docx", "xlsx", "pdf"]),
      material("layout", "版式与纸张要求", true, "说明一页或多页、A4、颜色及是否需要头像。"),
      material("export", "导出方式", true, "说明需要打印、PDF 或其他已有支持的输出。"),
      material("sample", "脱敏示例", false, "如需代测，只提供虚构或已脱敏的数据。", ["json", "txt", "docx", "xlsx"])
    ],
    caseBrief: "用“张小简”等虚构资料展示字段填写、版式预览和本地导出三步，界面标注“演示数据”。",
    deliveryChecks: ["在约定系统上从空目录按说明启动", "用虚构数据测试填写、保存和导出", "确认安装包不含真实简历、密钥或联网跟踪"]
  },
  "local-pdf-toolkit": {
    summary: "按已列明的功能交付本地 PDF 处理工具，处理前保留原文件，不绕过文件保护。",
    servicePoints: [
      "先确认需要合并、拆分、排序或转换中的哪些功能",
      "输入和输出目录分开，默认不覆盖原件",
      "异常文件给出明确失败提示"
    ],
    tierScopes: [
      "从当前版本已支持功能中确认 1 项，并附本地使用说明",
      "确认最多 3 项常用处理流程，含示例和批量命名规则",
      "按约定组合批处理流程，并补充异常文件与日志说明"
    ],
    materials: [
      material("os", "目标电脑环境", true, "说明系统版本和是否允许安装运行环境。"),
      material("operations", "需要的 PDF 操作", true, "逐项列出合并、拆分、排序、图片转换等实际步骤。"),
      material("samples", "脱敏样例文件", true, "每类提供 1 个可公开或已脱敏样例。", ["pdf", "jpg", "jpeg", "png", "zip"]),
      material("limits", "文件规模与限制", true, "说明大致页数、文件数量、单文件大小及是否加密。"),
      material("naming", "输出命名规则", false, "说明目录结构、文件名和覆盖冲突怎么处理。")
    ],
    caseBrief: "用自制三页 PDF 演示排序、拆分和合并后的文件列表，所有文档只含演示文字。",
    deliveryChecks: ["用脱敏样例逐项跑通约定功能", "确认页数、顺序、清晰度和文件名", "验证不会覆盖原文件，受保护文件会停止并提示"],
    boundaries: ["不破解 PDF 密码、不移除权限保护，不处理来源不明的机密文件"]
  },
  "desktop-file-organizer": {
    summary: "按买家确认的规则整理指定文件夹，先预览移动清单，再决定是否执行。",
    servicePoints: [
      "规则可按扩展名、日期或文件名关键词组合",
      "默认先做只读扫描和预演",
      "重名、占用和无法识别的文件单列处理"
    ],
    tierScopes: [
      "1 个文件夹、1 套简单分类规则，含预演清单",
      "多个子文件夹和多条规则，含重名策略与执行日志",
      "复杂规则、定时运行或回滚清单，先用副本验证"
    ],
    materials: [
      material("os", "电脑系统", true, "说明 Windows 版本和目标文件夹所在磁盘。"),
      material("sample-list", "脱敏文件名清单", true, "只发文件名和扩展名示例，不必先发真实文件。", ["txt", "csv", "xlsx"]),
      material("rules", "分类规则", true, "写清每类文件的判断条件、目标目录和优先级。", ["txt", "docx", "xlsx"]),
      material("conflicts", "重名与例外处理", true, "选择跳过、改名或移到待确认目录，默认不覆盖。"),
      material("backup", "备份与试运行目录", true, "首次只在副本或指定测试目录运行。")
    ],
    caseBrief: "用一组空白演示文件展示扫描结果、预演移动清单和整理后目录树，不读取任何真实桌面内容。",
    deliveryChecks: ["在测试目录先运行预演且不移动文件", "核对规则优先级、重名策略和路径边界", "执行后比较文件数量并生成可追溯清单"]
  },
  "web-mini-games": {
    summary: "交付能在常用浏览器打开的轻量小游戏，写清操作方法、素材来源和本地启动方式。",
    servicePoints: [
      "玩法和操作键先写成简短规则",
      "默认使用原创几何图形或许可明确的素材",
      "不接入付费、博彩或诱导充值逻辑"
    ],
    tierScopes: [
      "1 款现有轻量游戏和本地打开说明",
      "最多 3 款游戏，统一入口、配色和操作提示",
      "最多 5 款游戏，含约定主题调整、积分或本地记录"
    ],
    materials: [
      material("browser", "目标设备与浏览器", true, "说明电脑或手机、浏览器版本和是否要求离线。"),
      material("games", "玩法选择", true, "列出需要的游戏、胜负规则和单局时长。"),
      material("controls", "操作方式", true, "说明键盘、鼠标或触屏，以及需要的按键。"),
      material("theme", "主题与素材", false, "提供颜色和有权使用的图片、字体、音效。", ["jpg", "jpeg", "png", "svg", "mp3", "wav", "zip"]),
      material("storage", "本地记录要求", false, "说明是否保存最高分、设置或游戏进度。")
    ],
    caseBrief: "展示原创几何方块小游戏的开始、游玩和结算三个界面，使用虚构分数并注明“功能示意”。",
    deliveryChecks: ["在约定浏览器测试开始、暂停、重开和结算", "检查键盘与触屏操作及窄屏布局", "核对离线资源、素材许可证和本地记录清除方式"]
  },
  "original-agent-skills": {
    summary: "按明确任务交付自写的 Agent Skill 文件、使用说明和测试样例，并单列第三方依赖。",
    servicePoints: [
      "每个 Skill 写清触发条件、输入、输出和禁止动作",
      "用虚构数据提供可重复测试样例",
      "第三方模板或依赖必须保留许可证和原作者声明"
    ],
    tierScopes: [
      "1 个单一流程 Skill，含说明和 1 个测试样例",
      "最多 3 个关联 Skill，统一目录和交接说明",
      "最多 8 个同主题 Skill，含路由规则、测试集和版本记录"
    ],
    materials: [
      material("host", "目标 Agent 环境", true, "说明 Codex、其他兼容 Agent 及其当前版本。"),
      material("workflow", "真实任务流程", true, "按触发、步骤、输入和期望结果写一个完整例子。", ["txt", "md", "docx", "pdf"]),
      material("boundaries", "权限与禁止动作", true, "说明可读写目录、外部操作和必须人工确认的节点。"),
      material("samples", "脱敏样例", true, "提供虚构或脱敏输入及期望输出。", ["md", "txt", "json", "yaml", "zip"]),
      material("licenses", "依赖与许可证", true, "列出参考项目、第三方库和许可证；来源不明时不打包销售。", ["txt", "md", "json"])
    ],
    caseBrief: "用完全自写的“文件命名检查”小 Skill 展示触发、执行和测试结果，附目录树和许可证位置。",
    deliveryChecks: ["逐个核对触发条件、输入输出和权限边界", "在干净目录用虚构样例运行测试", "检查包内许可证、原作者声明、版本记录和无敏感数据"],
    boundaries: ["不复制无许可证、非商业许可或许可证义务未核清的第三方 Skill"]
  },
  "codex-cli-setup": {
    summary: "通过官方安装路径配置 Codex CLI，由买家本人完成登录和账号验证。",
    servicePoints: [
      "先检查系统、终端和运行环境",
      "安装后用非敏感示例验证命令可用",
      "登录、验证码和权限确认始终由买家本人操作"
    ],
    tierScopes: [
      "单机基础安装、版本检查和启动验证",
      "安装加登录流程指导、项目目录配置和常见报错处理",
      "复杂终端或多项目环境排查，含权限说明和操作记录"
    ],
    materials: [
      material("os", "系统与终端版本", true, "说明 Windows 版本、PowerShell 或其他终端及系统架构。"),
      material("runtime", "当前运行环境", true, "提供 Node、包管理器等版本输出，不要附任何令牌。", ["txt", "jpg", "png"]),
      material("source", "官方安装来源", true, "确认只使用官方文档和官方发布包。", ["txt", "pdf"]),
      material("error", "完整报错", false, "复制脱敏后的命令和报错，遮住用户名、路径隐私和令牌。", ["txt", "jpg", "png"]),
      material("consent", "远程操作授权", true, "远控前逐项确认范围和时间；密码、验证码和远控码不发送、不记录。")
    ],
    caseBrief: "用无账号的本地终端演示“环境检查—安装命令位置—版本验证”，登录步骤只画人工确认提示，不展示凭据。",
    deliveryChecks: ["人工确认远程授权范围和开始结束时间", "核对安装来源与命令版本", "由买家本人确认登录状态，再在测试目录运行只读示例", "检查操作记录不含令牌、验证码或远控码"],
    boundaries: ["不代过账号验证，不导出登录凭据，不使用破解包或非官方激活方式"]
  },
  "openclaw-setup": {
    summary: "按买家指定的官方来源和版本完成 OpenClaw 本地安装，并记录可复现的启动步骤。",
    servicePoints: [
      "安装前核对官方仓库、版本和系统前置条件",
      "只配置买家明确选择且官方支持的功能",
      "账号登录、密钥粘贴和验证由买家本人完成"
    ],
    tierScopes: [
      "完成前置检查、基础安装和本地启动验证",
      "基础安装加 1 项官方支持配置及常见报错处理",
      "复杂依赖、后台启动或升级问题排查，含配置与回滚记录"
    ],
    materials: [
      material("os", "系统与硬件环境", true, "说明系统版本、架构、可用内存和磁盘空间。"),
      material("source", "官方项目地址与版本", true, "提供要安装的官方地址、版本或发布页，避免同名项目。", ["txt", "pdf", "jpg", "png"]),
      material("goal", "需要启用的功能", true, "只列实际要用的官方功能和本地运行方式。"),
      material("error", "当前状态与报错", false, "提供脱敏日志和已执行步骤，不要包含密钥。", ["txt", "log", "jpg", "png", "zip"]),
      material("consent", "远程操作授权", true, "远控前确认目录、命令和时间；敏感配置由买家本人输入。")
    ],
    caseBrief: "用空白测试环境示意官方来源核对、依赖检查和本地健康状态，所有账号与密钥字段保持空白。",
    deliveryChecks: ["人工确认远程授权范围和官方来源", "记录实际安装版本、依赖和启动命令", "由买家本人完成敏感配置后检查本地健康状态", "确认日志和交接文档已去除凭据"],
    boundaries: ["不使用来源不明安装包，不代填密钥，不绕过服务验证或权限限制"]
  },
  "docker-compose-setup": {
    summary: "安装官方 Docker 环境并验证指定 Compose 项目，敏感环境变量由买家本人保管。",
    servicePoints: [
      "先检查系统虚拟化、WSL 或目标运行方式",
      "启动前检查 Compose 配置和端口冲突",
      "只记录变量名，不复制密码和密钥值"
    ],
    tierScopes: [
      "Docker 基础安装、版本检查和官方测试容器验证",
      "基础安装加 1 个现有 Compose 项目的配置检查与启动",
      "复杂网络、卷、构建或多服务故障排查，含回滚记录"
    ],
    materials: [
      material("os", "系统与虚拟化状态", true, "说明系统版本、架构、WSL 或虚拟化是否开启。", ["txt", "jpg", "png"]),
      material("compose", "Compose 配置", false, "发送已删除密码和密钥值的 compose 文件。", ["yml", "yaml", "json", "zip"]),
      material("goal", "目标服务与端口", true, "列出要运行的服务、端口、数据目录和预期访问方式。"),
      material("error", "完整报错与日志", false, "提供脱敏日志和复现步骤。", ["txt", "log", "jpg", "png", "zip"]),
      material("consent", "远程操作授权", true, "涉及安装、网络或磁盘目录变更前逐项确认；敏感值由买家输入。")
    ],
    caseBrief: "用无业务数据的 hello-world Compose 项目展示版本检查、配置校验、容器状态和停止流程。",
    deliveryChecks: ["人工确认安装、网络和目录变更范围", "运行版本与 Compose 配置校验", "检查目标服务健康、端口和卷路径", "停止并重启一次，确认日志不含密钥且有回滚说明"],
    boundaries: ["不部署破解镜像、非法代理、挖矿或来源不明的高风险容器"]
  },
  "remote-troubleshooting": {
    summary: "围绕一个可复现的软件问题做人工远程排查，先记录现状，再执行经确认的改动。",
    servicePoints: [
      "先复现并保存错误原文，不凭感觉改系统",
      "每项安装、卸载、注册表或网络改动先确认",
      "结束时给出已做动作、结果和未解决项"
    ],
    tierScopes: [
      "单一软件、单一明确报错的基础检查和常见修复",
      "涉及 2–3 个组件的依赖、权限或配置排查",
      "复杂环境或间歇性问题，按复现条件和影响范围确认排查计划"
    ],
    materials: [
      material("os", "系统与软件版本", true, "说明系统、故障软件和相关组件的准确版本。"),
      material("reproduce", "复现步骤", true, "从打开软件开始逐步写出怎样出现问题。", ["txt", "docx", "jpg", "png"]),
      material("error", "完整报错和脱敏日志", true, "保留错误代码与时间，删除账号、路径隐私和令牌。", ["txt", "log", "jpg", "png", "zip"]),
      material("changes", "近期改动", false, "列出安装、更新、清理或网络变化。"),
      material("consent", "备份与远程授权", true, "先备份重要文件，再确认可操作目录和时间；不发送密码、验证码或远控码。")
    ],
    caseBrief: "用虚构软件报错展示“复现—记录—单项修复—复测—回滚点”五步，不展示真实电脑或客户资料。",
    deliveryChecks: ["人工确认授权、备份和允许改动范围", "记录修复前后的复现结果", "逐项核对执行动作、回滚点和仍存在的问题", "清理临时文件并确认未保存凭据或远控码"],
    boundaries: ["不处理破解、盗版激活、非法代理、入侵或绕过账号验证的需求"]
  },
  "ppt-polish": {
    summary: "在不改动事实内容的前提下，统一 PPT 的字号、颜色、间距、对齐和页面节奏。",
    servicePoints: [
      "先锁定模板、页面数量和必须保留的元素",
      "统一标题、正文、图表和页码样式",
      "内容事实和最终用词由买家确认"
    ],
    tierScopes: [
      "5 页以内，做字体、对齐和基础版式统一",
      "15 页以内，含页面重排、图表样式和图片裁切",
      "30 页以内，含母版、章节体系和复杂页面统一"
    ],
    materials: [
      material("source", "可编辑 PPTX", true, "先自行备份，再发送可编辑文件而非只有截图。", ["pptx", "zip"]),
      material("template", "模板或品牌规范", false, "提供公司、学校模板，或明确颜色、字体和 Logo 规则。", ["pptx", "pdf", "png", "jpg", "zip"]),
      material("copy", "最终文字与数据", true, "标出仍会改动的页面；数字和事实由买家确认。", ["docx", "xlsx", "txt", "pdf"]),
      material("assets", "原始图片与图表数据", false, "提供清晰原图和图表源数据。", ["jpg", "jpeg", "png", "svg", "xlsx", "zip"]),
      material("deadline", "页数、用途与截止时间", true, "说明汇报、路演或打印，以及实际页数和交付时间。")
    ],
    caseBrief: "用虚构季度工作总结做三页排版示意，数据明确标注“演示数据”，展示统一前后而非虚构客户成果。",
    deliveryChecks: ["逐页检查文本溢出、对齐、留白和页码", "替换或嵌入字体后在另一台电脑打开", "检查放映、动画、图表数据和导出 PDF 是否正常"]
  },
  "excel-formula": {
    summary: "根据脱敏样例和期望结果修复或设计 Excel 公式，保留原表并标出改动位置。",
    servicePoints: [
      "先用样例行确认计算逻辑和边界情况",
      "公式写入副本，不覆盖唯一原文件",
      "复杂公式附字段说明和手工复核方法"
    ],
    tierScopes: [
      "1 个工作表、1 类明确公式问题或新公式",
      "最多 3 个工作表，含跨表引用和常见错误处理",
      "复杂多条件、动态区域或多表联动，先确认字段和样例结果"
    ],
    materials: [
      material("source", "Excel 副本", true, "删除不必要的个人信息并保留自己的原始备份。", ["xlsx", "xlsm", "xls", "zip"]),
      material("expected", "期望结果样例", true, "至少给 3 行输入和人工算出的正确结果。", ["xlsx", "txt", "jpg", "png"]),
      material("fields", "字段与业务规则", true, "解释每列含义、空值、日期和异常值怎么处理。", ["txt", "docx", "pdf"]),
      material("version", "Excel 版本", true, "说明 Windows 或 Mac 及版本，避免使用不兼容函数。"),
      material("protection", "保护与宏说明", false, "说明是否有宏或工作表保护；不要发送密码。")
    ],
    caseBrief: "用虚构订单表展示错误公式、预期结果和修复后公式，所有姓名与金额均为演示数据。",
    deliveryChecks: ["用买家提供的人工结果逐项对照", "检查空值、错误值、首行末行和新增行", "确认公式未被替换成固定值，原工作簿保持不变"]
  },
  "excel-clean-merge": {
    summary: "按确认的字段、去重和合并规则清洗 Excel 数据，并提供前后行数核对表。",
    servicePoints: [
      "先建立列名映射和唯一键",
      "缺失、重复和格式异常分别统计",
      "原文件只读保留，清洗结果另存"
    ],
    tierScopes: [
      "3 个以内同结构表格的合并、去空行或简单去重",
      "10 个以内表格，含列名映射、格式统一和去重规则",
      "多来源或结构不同的数据，含异常清单和核对汇总"
    ],
    materials: [
      material("sources", "脱敏表格副本", true, "删除不必要身份信息，按来源分别打包。", ["xlsx", "xls", "csv", "zip"]),
      material("mapping", "列名映射", true, "写清不同表中哪些列代表同一字段。", ["xlsx", "txt", "docx"]),
      material("dedupe", "去重与保留规则", true, "指定唯一键、重复时保留哪条、空值如何处理。"),
      material("output", "输出结构样例", true, "给出最终列顺序、日期格式、编码和文件格式。", ["xlsx", "csv", "txt"]),
      material("consent", "个人信息处理确认", true, "只提供完成任务所必需的数据；发送给 Codex 前需另行同意。")
    ],
    caseBrief: "用三份虚构库存表展示列名映射、重复标记和合并后的行数核对，不含真实客户数据。",
    deliveryChecks: ["核对各来源输入行数、输出行数和剔除原因", "抽查重复键、空值、日期、前导零和乱码", "确认列顺序、公式处理方式和异常清单完整"]
  },
  "word-long-format": {
    summary: "用 Word 样式整理长文档的标题、正文、目录、页眉页脚和图表编号。",
    servicePoints: [
      "先确认学校或公司的格式规范",
      "使用样式而不是逐段手工改字体",
      "正文事实和引用内容不代写、不改写结论"
    ],
    tierScopes: [
      "10 页以内，统一标题、正文、段落和页码",
      "30 页以内，含多级标题、自动目录、页眉页脚和图表编号",
      "80 页以内复杂长文档，含分节、交叉引用和版式问题排查"
    ],
    materials: [
      material("source", "可编辑 DOCX", true, "先保留原始备份，再提供可编辑副本。", ["docx", "zip"]),
      material("standard", "格式规范", true, "提供学校、公司或出版社的明确格式文件。", ["docx", "pdf", "jpg", "png"]),
      material("structure", "标题层级说明", true, "标出一级至三级标题、附录和不进目录的部分。", ["txt", "docx", "pdf"]),
      material("assets", "原始图片与表格", false, "复杂图片、公式或表格最好提供源文件。", ["jpg", "jpeg", "png", "xlsx", "zip"]),
      material("fonts", "字体与打印要求", true, "说明指定字体、单双面、纸张和是否需要 PDF。")
    ],
    caseBrief: "用自写的五页演示报告展示样式窗格、自动目录和图表编号，内容只讲排版步骤。",
    deliveryChecks: ["更新全部目录、页码、题注和交叉引用", "检查分节符、孤行、表格跨页和图片清晰度", "在另一台电脑打开并核对字体替换与 PDF 页数"]
  },
  "resume-layout": {
    summary: "只整理买家提供的真实简历内容，使层级、间距和重点更清楚，不编造经历。",
    servicePoints: [
      "先确认投递方向和必须保留的信息",
      "统一时间、标题、项目和技能的阅读顺序",
      "任何经历、成绩和数字都由买家确认"
    ],
    tierScopes: [
      "1 页中文简历，统一字体、间距和基础栏目",
      "1–2 页简历，含栏目重排、重点层级和 PDF 检查",
      "同一真实内容的 2 个投递方向版式，或中英文排版适配"
    ],
    materials: [
      material("source", "现有简历副本", true, "可先隐去身份证号、住址等非必要信息。", ["docx", "pdf", "txt", "zip"]),
      material("target", "投递方向", true, "说明岗位类型、行业和希望突出哪些真实经历。"),
      material("facts", "最终事实内容", true, "确认时间、单位、项目、技能和数字均真实准确。", ["docx", "txt", "xlsx"]),
      material("photo", "头像与使用授权", false, "如需头像，提供本人清晰照片并确认使用。", ["jpg", "jpeg", "png"]),
      material("format", "交付格式与页数", true, "说明 DOCX、PDF、A4 以及一页或两页。")
    ],
    caseBrief: "用完全虚构的应届生简历展示排版层级前后，姓名、学校、公司和数据均标注“演示”。",
    deliveryChecks: ["逐项核对姓名、日期、单位、项目和数字未被改写", "检查错别字、时间格式、对齐和一页边界", "确认 DOCX 可编辑、PDF 字体正常且链接可点击"],
    boundaries: ["不编造学历、工作经历、证书、业绩或项目数据"]
  },
  "portfolio-page": {
    summary: "把买家提供的真实介绍和作品整理成一个响应式单页，并交付源码与启动说明。",
    servicePoints: [
      "先确定栏目、内容顺序和每个作品的真实链接",
      "默认适配电脑、平板和手机宽度",
      "上线前由买家确认公开的联系方式和素材权利"
    ],
    tierScopes: [
      "基础单页、最多 4 个栏目，使用现成结构和已备齐内容",
      "最多 6 个栏目，含响应式、项目卡片、联系入口和部署说明",
      "定制视觉与约定交互，含源码整理、可访问性检查和上线协助"
    ],
    materials: [
      material("copy", "页面文字", true, "提供姓名或品牌名、简介、栏目标题和联系方式。", ["txt", "docx", "md", "pdf"]),
      material("projects", "作品资料", true, "每项提供真实标题、说明、链接、职责和可公开范围。", ["docx", "xlsx", "md", "txt", "zip"]),
      material("assets", "图片与品牌素材", true, "提供有权公开的头像、作品图、Logo 和字体。", ["jpg", "jpeg", "png", "svg", "webp", "zip"]),
      material("style", "风格与颜色", false, "可发喜欢的版式截图，说明想保留和不想要的部分。", ["jpg", "jpeg", "png", "pdf"]),
      material("deploy", "域名与部署选择", false, "说明是否已有域名和平台账号；登录与验证由买家本人完成。")
    ],
    caseBrief: "用虚构设计师和自制几何作品图展示首页、项目卡片和手机布局，所有链接标注“演示”。",
    deliveryChecks: ["逐项核对作品事实、链接和公开联系方式", "在桌面、平板和手机宽度检查布局与键盘操作", "检查图片授权、加载速度、页面标题和启动部署说明"]
  },
  "static-site-deploy": {
    summary: "把已有静态网站部署到买家选择的平台，先本地构建，再处理域名、HTTPS 和回滚。",
    servicePoints: [
      "先确认源码能在干净环境构建",
      "平台登录、验证码和 DNS 最终确认由买家本人操作",
      "交付部署地址、构建记录和回滚方法"
    ],
    tierScopes: [
      "1 个现有静态站部署到 1 个已确认平台，使用平台默认域名",
      "含自定义域名、HTTPS、基础环境配置和一次重部署验证",
      "复杂构建、单页路由或多环境配置，含故障排查和回滚记录"
    ],
    materials: [
      material("source", "网站源码", true, "提供可构建源码或压缩包，并说明许可证。", ["zip", "tar", "gz", "txt", "md"]),
      material("build", "构建方法", true, "提供运行版本、安装命令、构建命令和输出目录，不含密钥值。", ["txt", "md", "json"]),
      material("platform", "目标部署平台", true, "说明账号是否已创建；登录和验证由买家本人完成。"),
      material("domain", "域名与 DNS", false, "提供域名和需要添加的记录；不要发送注册商密码或验证码。", ["txt", "jpg", "png"]),
      material("env", "环境变量名称", false, "只列变量名及用途，敏感值由买家在平台中输入。", ["txt", "md"]),
      material("rights", "代码与素材授权", true, "确认源码、字体、图片和依赖允许当前部署。")
    ],
    caseBrief: "用自写的单页演示站展示本地构建、平台预览地址、自定义域名和回滚节点，不展示任何真实账号。",
    deliveryChecks: ["在干净目录完成依赖安装和正式构建", "检查首页、资源路径、刷新路由、404 和移动端", "由买家确认 HTTPS、DNS 和公开内容，再复测一次部署", "交付源码版本、部署地址、环境变量名和回滚步骤"],
    boundaries: ["不索要账号密码、验证码或域名转移码，不部署侵权、钓鱼、破解或非法代理站点"]
  }
};

function scopeFor(category: Product["category"], index: number): string {
  const scopes: Record<Product["category"], string[]> = {
    图片: ["单张、改动明确的小范围处理", "1–3 张或包含细节校正", "多图、复杂合成或统一风格"],
    工具: ["现成基础功能与说明", "按使用流程做轻量调整", "复杂流程、更多功能与部署指导"],
    安装: ["单项基础安装与检查", "安装、配置和常见问题处理", "复杂环境排查与完整记录"],
    办公: ["少量页面或单一问题", "中等篇幅与统一格式", "长文档、复杂结构或多轮校对"],
    前端: ["基础单页与现成结构", "完整内容、响应式和部署", "定制视觉、交互与完整交付"],
  };
  return scopes[category][index] ?? scopes[category][0]!;
}

export function makePriceTiers(product: Product): PriceTier[] {
  const profile = PRODUCT_CONTENT_PROFILES[product.slug];
  return product.prices.map((price, index) => ({
    name: TIER_NAMES[index]!,
    price,
    floorPrice: floorPrice(price),
    revisions: REVISIONS[index]!,
    scope: profile?.tierScopes[index] ?? scopeFor(product.category, index)
  }));
}

export function generateContentBundle(product: Product): ContentBundle {
  const profile = PRODUCT_CONTENT_PROFILES[product.slug];
  const tiers = makePriceTiers(product);
  const start = product.prices[0];
  const remote = product.remoteService;
  const materials = profile?.materials ?? CATEGORY_MATERIALS[product.category];
  const serviceSummary = profile?.summary ?? `处理${product.name}，先核对材料、范围和使用场景。`;
  const servicePoints = profile?.servicePoints ?? ["按确认范围制作", "交付前检查成品"];
  const boundaryCopy = profile?.boundaries?.length
    ? `边界：${profile.boundaries.join("；")}。`
    : undefined;
  const titleCandidates = [
    `${product.name}｜先看材料再报价`,
    `${product.name}｜${start}元起`,
    `${product.name}｜范围确认后开工`
  ];
  const description = [
    `${serviceSummary}先把材料发来，我会先看是否能做，再确认档位和交付时间。`,
    `具体内容：${servicePoints.join("；")}。`,
    `三档范围：基础档 ${tiers[0]!.price} 元，${tiers[0]!.scope}；标准档 ${tiers[1]!.price} 元，${tiers[1]!.scope}；进阶档 ${tiers[2]!.price} 元，${tiers[2]!.scope}。复杂情况先看材料，不会没看就定价。`,
    `基础、标准、进阶分别含 1、2、3 次同范围修改。需求方向或工作范围变化，需要重新确认价格。`,
    remote
      ? "远程服务会先确认授权范围和时间。操作由人工完成，不保存密码、验证码或远控码。"
      : "交付前会检查文件是否能打开，并附使用说明。材料不完整时先补材料，不会直接开工。",
    boundaryCopy,
    "不接侵权、破解、凭证造假、非法代理等需求。涉及他人素材时，请确认你有权使用和修改。"
  ].filter((paragraph): paragraph is string => Boolean(paragraph)).join("\n\n");

  const imagePlan: ContentBundle["imagePlan"] = [
    { index: 1, role: "cover", title: product.name, brief: "深蓝品牌封面，突出商品名和真实起价。", source: "local_template" },
    { index: 2, role: "case", title: "效果参考", brief: profile?.caseBrief ?? "展示自制或虚构数据的服务示意，不冒充真实客户案例。", source: "codex_imagegen" },
    { index: 3, role: "pricing", title: "三档价格与范围", brief: `逐项列出本商品三档范围、标价和 ${REVISIONS.join("/")} 次同范围修改。`, source: "local_template" },
    { index: 4, role: "process", title: "服务流程", brief: `材料确认、范围报价、${remote ? "人工授权操作" : "制作"}、逐项检查、交付。`, source: "local_template" },
    { index: 5, role: "materials", title: "需要准备的材料", brief: `列出本商品需要的${materials.map((item) => item.label).join("、")}，区分必需与可选。`, source: "local_template" },
    { index: 6, role: "after_sales", title: "修改与禁接范围", brief: `说明 1/2/3 次同范围修改、${profile?.boundaries?.join("；") ?? "需求变更重新报价"}及统一拒绝事项。`, source: "local_template" }
  ] as [ImageBrief, ImageBrief, ImageBrief, ImageBrief, ImageBrief, ImageBrief];

  const profileChecks = profile?.deliveryChecks ?? ["检查成品可打开", "核对成品与确认范围一致"];
  const commonDeliveryChecks = remote
    ? ["记录授权范围和操作时间", "全程人工执行并记录动作摘要和结果"]
    : ["检查成品可打开", "加入使用说明", "生成 SHA256SUMS", "平台附件优先", "大文件转百度上传或等待粘贴链接"];

  return {
    titleCandidates,
    selectedTitle: titleCandidates[1]!,
    description,
    priceTiers: tiers,
    materials: structuredClone(materials),
    imagePlan,
    faq: [
      { question: "可以先做再付款吗？", answer: "先确认材料、范围和价格，按平台订单流程开始。" },
      { question: "不满意怎么办？", answer: `在已确认范围内按套餐包含的 ${tiers.map((tier) => `${tier.name}${tier.revisions}次`).join("、")} 修改；方向变化另行确认。` },
      { question: "多久完成？", answer: "看完材料后确认。加急只有人工确认可接时才报价。" },
      { question: "会保存我的文件吗？", answer: "原客户文件默认保留 30 天，到期清理；如需提前删除可以提出。" }
    ],
    deliveryPlan: {
      mode: remote ? "remote_service" : "platform_attachment",
      packageRequired: !remote,
      checklist: [...profileChecks, ...commonDeliveryChecks]
    },
    claims: [
      { text: `${start} 元起`, evidence: `商品基础档标价 ${start} 元` },
      { text: "同范围包含修改", evidence: "固定套餐规则：1/2/3 次" },
      { text: "先看材料再确认", evidence: "复杂订单按材料完整度估价" }
    ],
    complianceFlags: productNeedsLicenseReview(product)
      ? ["发布和交付前必须核验自有原创声明、第三方依赖许可证与原作者署名；缺失、AGPL、非商业或未知许可证默认阻止"]
      : []
  };
}

const BANNED_COPY = [/一站式解决/i, /赋能/i, /行业领先/i, /百分百满意/i, /纯手工/i, /全网最低/i];

export function validateContentBundle(bundle: ContentBundle): string[] {
  const issues: string[] = [];
  if (bundle.imagePlan.length !== 6) issues.push("商品图必须正好六张");
  if (!bundle.titleCandidates.includes(bundle.selectedTitle)) issues.push("选中标题不在候选列表中");
  if (bundle.priceTiers.length !== 3) issues.push("价格档必须正好三档");
  if (bundle.priceTiers.some((tier, index) => tier.revisions !== REVISIONS[index])) issues.push("修改次数不符合固定规则");
  if (bundle.priceTiers.some((tier) => !tier.scope.trim())) issues.push("价格档缺少范围说明");
  if (bundle.priceTiers.some((tier) => tier.floorPrice !== floorPrice(tier.price))) issues.push("价格底线不一致");
  if (bundle.priceTiers.some((tier) => !bundle.description.includes(`${tier.name}档 ${tier.price} 元`))) issues.push("详情文案与价格档不一致");
  for (const pattern of BANNED_COPY) if (pattern.test(`${bundle.selectedTitle}\n${bundle.description}`)) issues.push(`文案包含禁用表达：${pattern.source}`);
  if (bundle.materials.length === 0 || !bundle.materials.some((item) => item.required)) issues.push("材料清单缺少必需项");
  if (new Set(bundle.materials.map((item) => item.id)).size !== bundle.materials.length) issues.push("材料清单 ID 重复");
  if (bundle.faq.length === 0) issues.push("FAQ 不能为空");
  if (bundle.faq.some((item) => !item.question.trim() || !item.answer.trim())) issues.push("FAQ 问题或答案为空");
  if (bundle.faq.some((item) => item.question.length > 120 || item.answer.length > 500)) issues.push("FAQ 问题或答案过长");
  const normalizedFaqQuestions = bundle.faq.map((item) => normalizeFaqQuestion(item.question));
  if (new Set(normalizedFaqQuestions).size !== normalizedFaqQuestions.length) issues.push("FAQ 问题重复");
  for (const pattern of BANNED_COPY) if (pattern.test(bundle.faq.map((item) => `${item.question}\n${item.answer}`).join("\n"))) issues.push(`FAQ 包含禁用表达：${pattern.source}`);
  const riskyFaqReason = bundle.faq.map((item) => hardHandoffReason(`${item.question}\n${item.answer}`)).find((reason): reason is string => Boolean(reason));
  if (riskyFaqReason) issues.push(`FAQ 包含必须人工接管内容：${riskyFaqReason}`);
  if (bundle.imagePlan.some((image) => !image.brief.trim())) issues.push("商品图缺少具体说明");
  if (bundle.deliveryPlan.checklist.length === 0) issues.push("交付计划缺少检查项");
  if (bundle.claims.some((claim) => !claim.evidence.trim())) issues.push("事实声明缺少证据");
  return issues;
}

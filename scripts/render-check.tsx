/**
 * 额度面板的渲染断言：直接跑 renderToStaticMarkup，验证四个窗口都渲染出来、
 * 数字和重置倒计时格式对得上。这个文件不进主编译，用 bun 单独跑。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QuotaPanel } from "../app/(admin)/page";

const NOW = 1778790000000;

const upstreams = [
  {
    id: "u_1",
    name: "火山 Agent Plan",
    enabled: true,
    models: ["*"],
    priority: 10,
    concurrency: 8,
    hasQuota: true,
    minRemainingPct: 5,
    today: { req: 0, err: 0, pt: 0, ct: 0, tokens: 0, avgTtftMs: 0, avgMs: 0 },
    runtime: {
      inflight: 0,
      cooldownUntil: 0,
      cooldownReason: "",
      errEwma: 0,
      successTotal: 0,
      failTotal: 0,
      lastStatus: 0,
      lastLatencyMs: 0,
      quota: {
        planType: "Large",
        remainingPct: 57.475,
        fetchedAt: NOW - 60_000,
        windows: {
          fiveHour: { quota: 50, used: 12.5, resetTime: 1778806800000 },
          daily: { quota: 100, used: 22.5, resetTime: 1778803200000 },
          weekly: { quota: 500, used: 150, resetTime: 1779062400000 },
          monthly: { quota: 2000, used: 850.5, resetTime: 1780531200000 },
        },
      },
    },
  },
  {
    // 按量计费上游：没有额度快照，不该出现在面板里
    id: "u_2",
    name: "按量计费上游",
    enabled: true,
    models: ["*"],
    priority: 50,
    concurrency: 4,
    hasQuota: false,
    minRemainingPct: 0,
    today: { req: 0, err: 0, pt: 0, ct: 0, tokens: 0, avgTtftMs: 0, avgMs: 0 },
    runtime: null,
  },
];

const html = renderToStaticMarkup(<QuotaPanel upstreams={upstreams as never} now={NOW} />);

const cases: [string, string][] = [
  ["四个窗口标题", ">5 小时<"],
  ["日窗口", ">今日<"],
  ["周窗口", ">本周<"],
  ["月窗口", ">本月<"],
  ["套餐档位", ">Large<"],
  ["剩余百分比", "57.5%"],
  ["小数金额不被取整", "850.5 / 2000 AFP"],
  ["五小时剩 75%", ">75.0%<"],
  ["本周剩 70%", ">70.0%<"],
  ["重置倒计时（小时）", "4 小时 40 分后"],
  ["重置倒计时（天）", "20 天 3 小时后"],
  ["阈值展示", "触发阈值 5%"],
];

let failed = 0;
for (const [name, needle] of cases) {
  if (html.includes(needle)) {
    console.log(`  ok  ${name}`);
  } else {
    console.error(`FAIL  ${name} —— 输出里找不到 ${JSON.stringify(needle)}`);
    failed += 1;
  }
}

// 按量计费上游不应该出现在面板里
if (html.includes("按量计费上游")) {
  console.error("FAIL  按量计费上游不应出现在额度面板里");
  failed += 1;
} else {
  console.log("  ok  按量计费上游被排除");
}

// 没越线的时候不应该出现警示色
if (html.includes("bg-destructive")) {
  console.error("FAIL  没有窗口低于阈值时不应该有警示配色");
  failed += 1;
} else {
  console.log("  ok  未越线时无警示配色");
}

// 把阈值提到 60%，月窗口的 57.475% 就越线了
const crossingHtml = renderToStaticMarkup(
  <QuotaPanel upstreams={[{ ...upstreams[0], minRemainingPct: 60 }] as never} now={NOW} />,
);
if (!crossingHtml.includes("bg-destructive")) {
  console.error("FAIL  低于阈值的窗口没有警示配色");
  failed += 1;
} else {
  console.log("  ok  低于阈值的窗口有警示配色");
}

console.log(failed === 0 ? "\n额度面板渲染断言全部通过" : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
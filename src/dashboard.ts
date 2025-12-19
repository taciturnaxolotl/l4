import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import "./dashboard.css";

interface TrafficData {
  granularity: string;
  data: Array<{ bucket?: number; bucket_hour?: number; bucket_day?: number; hits: number }>;
}

interface OverviewData {
  totalHits: number;
  uniqueImages: number;
  topImages: Array<{ image_key: string; total: number }>;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

class Dashboard {
  private days = 7;
  private chart: uPlot | null = null;
  private abortController: AbortController | null = null;

  private readonly totalHitsEl = document.getElementById("total-hits")!;
  private readonly uniqueImagesEl = document.getElementById("unique-images")!;
  private readonly imageListEl = document.getElementById("image-list")!;
  private readonly chartEl = document.getElementById("chart")!;
  private readonly buttons = document.querySelectorAll<HTMLButtonElement>(".time-selector button");

  constructor() {
    this.setupEventListeners();
    this.fetchData();
    window.addEventListener("resize", this.handleResize);
  }

  private setupEventListeners() {
    this.buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const newDays = parseInt(btn.dataset.days || "7");
        if (newDays !== this.days) {
          this.days = newDays;
          this.updateActiveButton();
          this.fetchData();
        }
      });
    });
  }

  private updateActiveButton() {
    this.buttons.forEach((btn) => {
      btn.classList.toggle("active", parseInt(btn.dataset.days || "0") === this.days);
    });
  }

  private async fetchData() {
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      const [overview, traffic] = await Promise.all([
        fetch(`/api/stats/overview?days=${this.days}`, { signal }).then((r) => r.json() as Promise<OverviewData>),
        fetch(`/api/stats/traffic?days=${this.days}`, { signal }).then((r) => r.json() as Promise<TrafficData>),
      ]);

      if (signal.aborted) return;

      this.renderOverview(overview);
      this.renderChart(traffic);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("Failed to fetch data:", e);
      }
    }
  }

  private renderOverview(data: OverviewData) {
    this.totalHitsEl.textContent = formatNumber(data.totalHits);
    this.uniqueImagesEl.textContent = String(data.uniqueImages);

    if (data.topImages.length === 0) {
      this.imageListEl.innerHTML = '<div class="loading">No data yet</div>';
      return;
    }

    this.imageListEl.innerHTML = data.topImages
      .map(
        (img, i) => `
        <div class="image-row" data-key="${img.image_key}">
          <div class="image-rank">${i + 1}</div>
          <div class="image-key">${img.image_key}</div>
          <div class="image-hits">${formatNumber(img.total)}</div>
        </div>
      `
      )
      .join("");

    this.imageListEl.querySelectorAll(".image-row").forEach((row) => {
      row.addEventListener("click", () => {
        const key = (row as HTMLElement).dataset.key;
        if (key) window.open(`/i/${key}`, "_blank");
      });
    });
  }

  private renderChart(data: TrafficData) {
    const timestamps: number[] = [];
    const hits: number[] = [];

    for (const point of data.data) {
      const ts = point.bucket ?? point.bucket_hour ?? point.bucket_day ?? 0;
      timestamps.push(ts);
      hits.push(point.hits);
    }

    if (timestamps.length === 0) {
      return;
    }

    const chartData: uPlot.AlignedData = [timestamps, hits];

    const opts: uPlot.Options = {
      width: this.chartEl.clientWidth,
      height: 280,
      cursor: {
        drag: { x: true, y: false },
      },
      select: {
        show: true,
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        {
          stroke: "#6b635a",
          grid: { stroke: "#e8e0d8", width: 1 },
        },
        {
          stroke: "#6b635a",
          grid: { stroke: "#e8e0d8", width: 1 },
          size: 60,
          values: (_, ticks) => ticks.map((v) => formatNumber(v)),
        },
      ],
      series: [
        {},
        {
          label: "Hits",
          stroke: "#dc602e",
          fill: "rgba(220, 96, 46, 0.1)",
          width: 2,
          points: { show: false },
        },
      ],
      hooks: {
        setSelect: [
          (u) => {
            if (u.select.width > 0) {
              const min = u.posToVal(u.select.left, "x");
              const max = u.posToVal(u.select.left + u.select.width, "x");
              u.setScale("x", { min, max });
              u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            }
          },
        ],
      },
    };

    if (this.chart) {
      this.chart.destroy();
    }

    this.chartEl.innerHTML = "";
    this.chart = new uPlot(opts, chartData, this.chartEl);
  }

  private handleResize = () => {
    if (this.chart) {
      this.chart.setSize({
        width: this.chartEl.clientWidth,
        height: 280,
      });
    }
  };
}

new Dashboard();

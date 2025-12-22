import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import "./dashboard.css";

interface TrafficData {
	granularity: string;
	data: Array<{
		bucket?: number;
		bucket_hour?: number;
		bucket_day?: number;
		hits: number;
	}>;
}

interface OverviewData {
	totalHits: number;
	uniqueImages: number;
	topImages: Array<{ image_key: string; total: number }>;
}

type Granularity = "10min" | "hourly" | "daily";

interface LodCacheEntry {
	granularity: Granularity;
	range: { start: number; end: number };
	timestamps: number[];
	hits: number[];
}

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}

function downsample(
	timestamps: number[],
	hits: number[],
	minX: number,
	maxX: number,
	maxPoints: number,
): { timestamps: number[]; hits: number[] } {
	const startIdx = timestamps.findIndex((t) => t >= minX);
	if (startIdx === -1) return { timestamps: [], hits: [] };

	let endIdx = timestamps.length - 1;
	for (let i = timestamps.length - 1; i >= 0; i--) {
		if (timestamps[i]! <= maxX) {
			endIdx = i;
			break;
		}
	}

	const sliceLen = endIdx - startIdx + 1;
	if (sliceLen <= 0) return { timestamps: [], hits: [] };

	const tsSlice = timestamps.slice(startIdx, endIdx + 1);
	const hSlice = hits.slice(startIdx, endIdx + 1);

	if (sliceLen <= maxPoints) {
		return { timestamps: tsSlice, hits: hSlice };
	}

	const bucketSize = Math.ceil(sliceLen / maxPoints);
	const dsTs: number[] = [];
	const dsHits: number[] = [];

	for (let i = 0; i < sliceLen; i += bucketSize) {
		const jEnd = Math.min(i + bucketSize, sliceLen);
		let sumHits = 0;
		for (let j = i; j < jEnd; j++) sumHits += hSlice[j]!;
		const avgHits = sumHits / (jEnd - i);
		dsTs.push(tsSlice[i]!);
		dsHits.push(avgHits);
	}

	return { timestamps: dsTs, hits: dsHits };
}

class Dashboard {
	private days = 7;
	private chart: uPlot | null = null;
	private abortController: AbortController | null = null;
	private originalRange: { start: number; end: number } | null = null;
	private currentRange: { start: number; end: number } | null = null;
	private lodCache: Partial<Record<Granularity, LodCacheEntry>> = {};
	private activeGranularity: Granularity | null = null;
	private isLoading = false;

	private readonly totalHitsEl = document.getElementById(
		"total-hits",
	) as HTMLElement;
	private readonly uniqueImagesEl = document.getElementById(
		"unique-images",
	) as HTMLElement;
	private readonly imageListEl = document.getElementById(
		"image-list",
	) as HTMLElement;
	private readonly chartEl = document.getElementById("chart") as HTMLElement;
	private readonly loadingEl = document.getElementById(
		"chart-loading",
	) as HTMLElement | null;
	private readonly buttons = document.querySelectorAll<HTMLButtonElement>(
		".time-selector button",
	);

	constructor() {
		this.days = this.getDaysFromUrl();
		this.updateActiveButton();
		this.setupEventListeners();
		this.fetchData();
		window.addEventListener("resize", this.handleResize);
		window.addEventListener("popstate", this.handlePopState);
	}

	private getDaysFromUrl(): number {
		const params = new URLSearchParams(window.location.search);
		const days = parseInt(params.get("days") || "7", 10);
		if ([1, 7, 30, 90, 365].includes(days)) {
			return days;
		}
		return 7;
	}

	private updateUrl(days: number) {
		const url = new URL(window.location.href);
		url.searchParams.set("days", String(days));
		window.history.pushState({ days }, "", url.toString());
	}

	private handlePopState = (event: PopStateEvent) => {
		const days = event.state?.days ?? this.getDaysFromUrl();
		if (days !== this.days) {
			this.days = days;
			this.currentRange = null;
			this.originalRange = null;
			this.lodCache = {};
			this.activeGranularity = null;
			this.updateActiveButton();
			this.fetchData();
		}
	};

	private setupEventListeners() {
		this.buttons.forEach((btn) => {
			btn.addEventListener("click", () => {
				const newDays = parseInt(btn.dataset.days || "7", 10);
				if (newDays !== this.days) {
					this.days = newDays;
					this.currentRange = null;
					this.originalRange = null;
					this.lodCache = {};
					this.activeGranularity = null;
					this.updateActiveButton();
					this.updateUrl(newDays);
					this.fetchData();
				}
			});
		});
	}

	private updateActiveButton() {
		this.buttons.forEach((btn) => {
			btn.classList.toggle(
				"active",
				parseInt(btn.dataset.days || "0", 10) === this.days,
			);
		});
	}

	private setLoading(loading: boolean) {
		this.isLoading = loading;
		if (this.loadingEl) {
			this.loadingEl.classList.toggle("visible", loading);
		}
	}

	private getGranularityForRange(start: number, end: number): Granularity {
		const spanDays = (end - start) / 86400;
		if (spanDays <= 1) return "10min";
		if (spanDays <= 30) return "hourly";
		return "daily";
	}

	private async fetchData() {
		this.abortController?.abort();
		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		this.setLoading(true);

		try {
			let trafficUrl = `/api/stats/traffic?days=${this.days}`;

			if (this.currentRange) {
				trafficUrl = `/api/stats/traffic?start=${this.currentRange.start}&end=${this.currentRange.end}`;
			}

			const [overview, traffic] = await Promise.all([
				fetch(`/api/stats/overview?days=${this.days}`, { signal }).then(
					(r) => r.json() as Promise<OverviewData>,
				),
				fetch(trafficUrl, { signal }).then(
					(r) => r.json() as Promise<TrafficData>,
				),
			]);

			if (signal.aborted) return;

			this.renderOverview(overview);

			const { timestamps, hits } = this.transformTraffic(traffic);

			if (timestamps.length === 0) {
				return;
			}

			if (!this.chart) {
				this.initChart(timestamps, hits);
			}

			this.updateCache(traffic);
		} catch (e) {
			if ((e as Error).name !== "AbortError") {
				console.error("Failed to fetch data:", e);
			}
		} finally {
			if (!signal.aborted) {
				this.setLoading(false);
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
      `,
			)
			.join("");

		this.imageListEl.querySelectorAll(".image-row").forEach((row) => {
			row.addEventListener("click", () => {
				const key = (row as HTMLElement).dataset.key;
				if (key) window.open(`/i/${key}`, "_blank");
			});
		});
	}

	private transformTraffic(data: TrafficData): {
		timestamps: number[];
		hits: number[];
	} {
		const timestamps: number[] = [];
		const hits: number[] = [];

		for (const point of data.data) {
			const ts = point.bucket ?? point.bucket_hour ?? point.bucket_day ?? 0;
			timestamps.push(ts);
			hits.push(point.hits);
		}

		return { timestamps, hits };
	}

	private updateCache(traffic: TrafficData) {
		const { timestamps, hits } = this.transformTraffic(traffic);
		if (timestamps.length === 0) return;

		const first = timestamps[0]!;
		const last = timestamps[timestamps.length - 1]!;

		const gran = traffic.granularity as Granularity;

		this.lodCache[gran] = {
			granularity: gran,
			range: { start: first, end: last },
			timestamps,
			hits,
		};

		this.activeGranularity = gran;

		if (!this.currentRange) {
			this.originalRange = { start: first, end: last };
			this.renderCurrentViewport({ min: first, max: last });
		} else {
			this.renderCurrentViewport({
				min: this.currentRange.start,
				max: this.currentRange.end,
			});
		}
	}

	private getBestCacheForRange(
		minX: number,
		maxX: number,
	): LodCacheEntry | null {
		const lodPriority: Granularity[] = ["10min", "hourly", "daily"];

		for (const lod of lodPriority) {
			const cache = this.lodCache[lod];
			if (cache && cache.range.start <= minX && cache.range.end >= maxX) {
				return cache;
			}
		}

		for (const lod of lodPriority) {
			const cache = this.lodCache[lod];
			if (cache) return cache;
		}

		return null;
	}

	private renderCurrentViewport(forceRange?: { min: number; max: number }) {
		if (!this.chart) return;

		let minX: number | undefined;
		let maxX: number | undefined;

		if (forceRange) {
			minX = forceRange.min;
			maxX = forceRange.max;
		} else {
			const xScale = this.chart.scales.x;
			minX =
				xScale && xScale.min != null ? xScale.min : this.originalRange?.start;
			maxX =
				xScale && xScale.max != null ? xScale.max : this.originalRange?.end;
		}

		if (minX == null || maxX == null) return;

		const cache = this.getBestCacheForRange(minX, maxX);
		if (!cache) return;

		this.activeGranularity = cache.granularity;

		const width = this.chartEl.clientWidth || 600;
		const maxPoints = Math.min(width, 800);

		const { timestamps, hits } = downsample(
			cache.timestamps,
			cache.hits,
			minX,
			maxX,
			maxPoints,
		);

		if (timestamps.length === 0) return;

		this.chart.setData([timestamps, hits]);
		this.chart.setScale("x", { min: minX, max: maxX });
	}

	private handleSelect(u: uPlot) {
		if (u.select.width <= 10) return;

		let min = Math.floor(u.posToVal(u.select.left, "x"));
		let max = Math.floor(u.posToVal(u.select.left + u.select.width, "x"));

		u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);

		const minSpan = 1.5 * 86400;
		const span = max - min;
		if (span < minSpan) {
			const center = (min + max) / 2;
			min = Math.floor(center - minSpan / 2);
			max = Math.floor(center + minSpan / 2);
		}

		this.currentRange = { start: min, end: max };

		const bestCache = this.getBestCacheForRange(min, max);
		const targetGran = this.getGranularityForRange(min, max);

		if (bestCache && bestCache.granularity === targetGran) {
			this.renderCurrentViewport({ min, max });
			return;
		}

		this.renderCurrentViewport({ min, max });
		this.fetchData();
	}

	private resetZoom() {
		this.currentRange = null;

		if (this.originalRange && this.chart) {
			this.chart.setScale("x", {
				min: this.originalRange.start,
				max: this.originalRange.end,
			});
			this.renderCurrentViewport();
			this.fetchData();
		}
	}

	private initChart(timestamps: number[], hits: number[]) {
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
				x: {
					time: true,
					range: (u, dataMin, dataMax) => {
						let min = dataMin;
						let max = dataMax;
						const minSpan = 1.5 * 86400;
						const span = max - min;
						if (span < minSpan) {
							const center = (min + max) / 2;
							min = center - minSpan / 2;
							max = center + minSpan / 2;
						}
						return [min, max];
					},
				},
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
				setSelect: [(u) => this.handleSelect(u)],
				ready: [
					(u) => {
						u.over.addEventListener("dblclick", () => this.resetZoom());
					},
				],
			},
		};

		this.chartEl.innerHTML = "";
		this.chart = new uPlot(opts, [timestamps, hits], this.chartEl);
	}

	private handleResize = () => {
		if (this.chart) {
			this.chart.setSize({
				width: this.chartEl.clientWidth,
				height: 280,
			});
			this.renderCurrentViewport();
		}
	};
}

new Dashboard();

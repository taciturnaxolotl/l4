import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import "./dashboard.css";

const TIME_RANGES = [
	{ label: "24h", days: 1 },
	{ label: "7d", days: 7 },
	{ label: "30d", days: 30 },
	{ label: "90d", days: 90 },
	{ label: "1y", days: 365 },
];

interface TrafficData {
	granularity: "hourly" | "daily";
	data: Array<{ bucket_hour?: number; bucket_day?: number; hits: number }>;
}

interface OverviewData {
	totalHits: number;
	topImages: Array<{ image_key: string; total: number }>;
}

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}

function TrafficChart({ days }: { days: number }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<uPlot | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;

		async function fetchData() {
			setLoading(true);
			try {
				const res = await fetch(`/api/stats/traffic?days=${days}`);
				const json: TrafficData = await res.json();

				if (cancelled || !containerRef.current) return;

				const timestamps: number[] = [];
				const hits: number[] = [];

				for (const point of json.data) {
					const ts = point.bucket_hour ?? point.bucket_day ?? 0;
					timestamps.push(ts);
					hits.push(point.hits);
				}

				if (timestamps.length === 0) {
					setLoading(false);
					return;
				}

				const data: uPlot.AlignedData = [timestamps, hits];

				const opts: uPlot.Options = {
					width: containerRef.current.clientWidth,
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

				if (chartRef.current) {
					chartRef.current.destroy();
				}

				chartRef.current = new uPlot(opts, data, containerRef.current);
				setLoading(false);
			} catch (e) {
				console.error("Failed to fetch traffic data:", e);
				setLoading(false);
			}
		}

		fetchData();

		return () => {
			cancelled = true;
			if (chartRef.current) {
				chartRef.current.destroy();
				chartRef.current = null;
			}
		};
	}, [days]);

	useEffect(() => {
		function handleResize() {
			if (chartRef.current && containerRef.current) {
				chartRef.current.setSize({
					width: containerRef.current.clientWidth,
					height: 280,
				});
			}
		}
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	return (
		<div className="chart-container">
			<h2>Traffic Overview</h2>
			<div className="chart-wrapper" ref={containerRef}>
				{loading && <div className="loading">Loading...</div>}
			</div>
			<p className="chart-hint">Drag to zoom, double-click to reset</p>
		</div>
	);
}

function TopImages({ days }: { days: number }) {
	const [data, setData] = useState<OverviewData | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;

		async function fetchData() {
			setLoading(true);
			try {
				const res = await fetch(`/api/stats/overview?days=${days}`);
				const json: OverviewData = await res.json();
				if (!cancelled) {
					setData(json);
					setLoading(false);
				}
			} catch (e) {
				console.error("Failed to fetch overview:", e);
				setLoading(false);
			}
		}

		fetchData();
		return () => {
			cancelled = true;
		};
	}, [days]);

	if (loading) {
		return (
			<div className="top-images">
				<h2>Top Images</h2>
				<div className="loading">Loading...</div>
			</div>
		);
	}

	return (
		<>
			<div className="stats-grid">
				<div className="stat-card">
					<div className="label">Total Hits</div>
					<div className="value">{formatNumber(data?.totalHits ?? 0)}</div>
				</div>
				<div className="stat-card">
					<div className="label">Unique Images</div>
					<div className="value">{data?.topImages.length ?? 0}</div>
				</div>
			</div>

			<div className="top-images">
				<h2>Top Images</h2>
				<div className="image-list">
					{data?.topImages.map((img, i) => (
						<div
							key={img.image_key}
							className="image-row"
							onClick={() => window.open(`/i/${img.image_key}`, "_blank")}
						>
							<div className="image-rank">{i + 1}</div>
							<div className="image-key">{img.image_key}</div>
							<div className="image-hits">{formatNumber(img.total)}</div>
						</div>
					))}
					{(!data?.topImages || data.topImages.length === 0) && (
						<div className="loading">No data yet</div>
					)}
				</div>
			</div>
		</>
	);
}

function Dashboard() {
	const [days, setDays] = useState(7);

	return (
		<div className="dashboard">
			<header>
				<h1>L4 Stats</h1>
				<div className="time-selector">
					{TIME_RANGES.map((range) => (
						<button
							key={range.days}
							className={days === range.days ? "active" : ""}
							onClick={() => setDays(range.days)}
						>
							{range.label}
						</button>
					))}
				</div>
			</header>

			<TopImages days={days} />
			<TrafficChart days={days} />

			<footer>
				<span>
					Made with <span className="heart">♥</span> by{" "}
					<a
						href="https://dunkirk.sh"
						target="_blank"
						rel="noopener noreferrer"
					>
						Kieran Klukas
					</a>
				</span>
				<a
					className="repo-link"
					href="https://tangled.org/dunkirk.sh/l4"
					target="_blank"
					rel="noopener noreferrer"
				>
					View source on Tangled
				</a>
			</footer>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<Dashboard />);

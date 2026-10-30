// The outcome chart: one series of horizontal bars with labels on the left, because bit strings get long.
// Values come straight from the reply. There is a table view with every row, and the bars carry no text of their own.
import { axisTicks, formatNumber, inBitOrder, limitRows } from "./format.mjs";

const el = (tag, className, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};

const LABEL_ALL_UP_TO = 12;

function renderBars(host, rows, unit) {
	const { shown, hiddenCount, hiddenTotal } = limitRows(rows);
	const max = Math.max(...rows.map((row) => row.value), 0);
	const ticks = axisTicks(max);
	const scaleMax = ticks.at(-1) || 1;
	// Every row and the axis share one label column, so the bars and the ticks line up. Longer strings wrap.
	host.style.setProperty("--label-chars", String(Math.min(26, Math.max(...shown.map((row) => row.outcome.length), 3))));

	const list = el("ol", "bars");
	list.setAttribute("aria-label", `Outcomes by ${unit}`);
	shown.forEach((row, index) => {
		const item = el("li", "bar-row");
		item.tabIndex = 0;
		const value = formatNumber(row.value);
		item.setAttribute("aria-label", `${row.outcome}: ${value}`);
		item.append(el("span", "bar-label", row.outcome));
		const track = el("span", "bar-track");
		const bar = el("span", "bar");
		bar.style.setProperty("--share", String(row.value / scaleMax));
		bar.style.setProperty("--delay", `${Math.min(index, 12) * 24}ms`);
		track.append(bar);
		if (shown.length <= LABEL_ALL_UP_TO || index < 3) track.append(el("span", "bar-value", value));
		const tip = el("span", "bar-tip", `${row.outcome}  ${value}`);
		track.append(tip);
		item.append(track);
		list.append(item);
	});
	host.append(list);

	const axis = el("div", "bar-axis");
	axis.setAttribute("aria-hidden", "true");
	const scale = el("div", "bar-axis-scale");
	for (const tick of ticks) {
		const mark = el("span", "bar-axis-tick", formatNumber(tick));
		mark.style.setProperty("--at", String(tick / scaleMax));
		scale.append(mark);
	}
	axis.append(scale);
	host.append(axis);

	if (hiddenCount) host.append(el("p", "chart-note", `${formatNumber(hiddenCount)} more outcomes, adding up to ${formatNumber(hiddenTotal)}. The table has all of them.`));
}

function renderTable(host, rows, unit) {
	const wrap = el("div", "table-wrap");
	const table = el("table", "data-table");
	const head = el("thead");
	const headRow = el("tr");
	headRow.append(el("th", "", "Outcome"), el("th", "num", unit === "count" ? "Count" : "Probability"));
	head.append(headRow);
	const body = el("tbody");
	for (const row of rows.slice(0, 5000)) {
		const tr = el("tr");
		const outcome = el("td", "mono", row.outcome);
		// The table keeps the service's value exactly as sent.
		tr.append(outcome, el("td", "num mono", String(row.value)));
		body.append(tr);
	}
	table.append(head, body);
	wrap.append(table);
	host.append(wrap);
	if (rows.length > 5000) host.append(el("p", "chart-note", `Showing the largest 5,000 of ${formatNumber(rows.length)} rows. The full reply below has them all.`));
}

/** Draws the chart with its controls into `host`. `rows` is already sorted largest first. */
export function renderOutcomes(host, rows, unit) {
	host.replaceChildren();
	const controls = el("div", "chart-controls");
	const title = el("p", "chart-title", unit === "count" ? "How many draws landed on each outcome" : "Exact probability of each outcome");
	const toggles = el("div", "chart-toggles");
	const orderButton = el("button", "link-button", "Bit order");
	orderButton.type = "button";
	const viewButton = el("button", "link-button", "Show table");
	viewButton.type = "button";
	toggles.append(orderButton, viewButton);
	controls.append(title, toggles);
	const canvas = el("div", "chart-canvas");
	host.append(controls, canvas);

	let bitOrder = false;
	let tableView = false;
	const draw = () => {
		canvas.replaceChildren();
		const ordered = bitOrder ? inBitOrder(rows) : rows;
		if (tableView) renderTable(canvas, ordered, unit);
		else renderBars(canvas, ordered, unit);
		orderButton.textContent = bitOrder ? "Largest first" : "Bit order";
		viewButton.textContent = tableView ? "Show bars" : "Show table";
	};
	orderButton.addEventListener("click", () => { bitOrder = !bitOrder; draw(); });
	viewButton.addEventListener("click", () => { tableView = !tableView; draw(); });
	draw();
}

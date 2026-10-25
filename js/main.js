document.addEventListener("DOMContentLoaded", () => {
  const progress = document.getElementById("progress");

  window.addEventListener("scroll", () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = `${max > 0 ? window.scrollY / max * 100 : 0}%`;
  }, { passive: true });

  initializeCountyMap();
});

const mapMetrics = {
  listed_facility_count: {
    label: "Listed facilities",
    format: value => `${d3.format(",.0f")(value)} listed facilities`,
    legendFormat: value => d3.format(",.0f")(value),
    scale: "sqrt",
    showZeroCount: true,
  },
  operating_facility_count: {
    label: "Operating facilities",
    format: value => `${d3.format(",.0f")(value)} operating facilities`,
    legendFormat: value => d3.format(",.0f")(value),
    scale: "sqrt",
    showZeroCount: true,
  },
};

const turquoiseAt = value => d3.hsl(177, 0.72, 0.14 + value * 0.50).formatRgb();

async function initializeCountyMap() {
  const stage = document.getElementById("map-stage");
  const loading = document.getElementById("map-loading");
  const measureOptions = document.querySelectorAll(".map-measure-option");
  const tooltip = document.getElementById("map-tooltip");
  const regionPopup = document.getElementById("region-popup");
  const summary = document.getElementById("map-summary");
  const legend = document.getElementById("map-legend");
  let selectedState = null;
  let renderMap = () => {};

  try {
    const svg = d3.select("#county-map");
    const [rows, topology] = await Promise.all([
      d3.csv("data/cleaned_dataset_with_water(in).csv"),
      d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json"),
    ]);
    const data = new Map(rows.map(row => [String(row.county_fips).padStart(5, "0"), row]));
    const counties = topojson.feature(topology, topology.objects.counties).features;
    const geometry = { type: "FeatureCollection", features: counties };
    const stateTotals = d3.rollup(rows, countyRows => ({
      listed: d3.sum(countyRows, row => Number(row.listed_facility_count) || 0),
      operating: d3.sum(countyRows, row => Number(row.operating_facility_count) || 0),
      counties: countyRows.length,
    }), row => row.state, row => row.state_name);

    function countyValue(county, metric) {
      const row = data.get(String(county.id).padStart(5, "0"));
      if (!row || row[metric] === undefined || row[metric] === "") return null;
      const value = Number(row[metric]);
      return Number.isFinite(value) ? value : null;
    }

    function render() {
      const width = stage.clientWidth;
      if (!width) return;
      const height = Math.max(340, Math.min(620, width * 0.57));
      const projection = d3.geoAlbersUsa().fitSize([width - 24, height - 20], geometry);
      const path = d3.geoPath(projection);
      const metric = document.querySelector(".map-measure-option[aria-pressed='true']").dataset.metric;
      const config = mapMetrics[metric];
      const values = counties.map(county => countyValue(county, metric)).filter(value => value !== null);
      const min = d3.min(values) ?? 0;
      const max = d3.max(values) || 1;
      const interpolator = turquoiseAt;
      const color = config.scale === "sqrt"
        ? d3.scaleSequentialSqrt(interpolator).domain([0, max])
        : d3.scaleSequential(interpolator).domain([min, max]);
      svg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
      svg.selectAll("path")
        .data(counties, county => county.id)
        .join("path")
        .attr("class", "county")
        .classed("state-selected", county => {
          const row = data.get(String(county.id).padStart(5, "0"));
          return Boolean(selectedState && row?.state === selectedState);
        })
        .attr("d", path)
        .attr("fill", county => {
          const value = countyValue(county, metric);
          return value === null ? "#101827" : color(value);
        })
        .on("pointerenter pointermove", (event, county) => showCounty(event, county, metric, config))
        .on("click", (event, county) => {
          const row = data.get(String(county.id).padStart(5, "0"));
          if (row) selectState(row.state);
        })
        .on("pointerleave", () => { tooltip.hidden = true; });

      svg.selectAll(".state-boundaries")
        .data([topojson.mesh(topology, topology.objects.states, (a, b) => a !== b)])
        .join("path")
        .attr("class", "state-boundaries")
        .attr("d", path)
        .attr("fill", "none")
        .attr("stroke", "rgba(160,185,230,.48)")
        .attr("stroke-width", ".8px")
        .attr("pointer-events", "none")
        .attr("vector-effect", "non-scaling-stroke");

      const zeroCount = values.filter(value => value === 0).length;
      const legendTicks = `<span>${config.legendFormat(min)}</span><span>${config.legendFormat(max)}</span>`;
      const gradientStops = d3.range(0, 1.01, 0.25)
        .map(position => `${d3.color(color(min + (max - min) * position)).formatHex()} ${position * 100}%`)
        .join(", ");
      const zeroNote = config.showZeroCount ? `<span>· ${zeroCount.toLocaleString()} counties at 0</span>` : "";
      legend.innerHTML = `<span>LOW</span><div class="legend-scale"><div class="legend-gradient" style="background:linear-gradient(90deg,${gradientStops})"></div><div class="legend-labels">${legendTicks}</div></div><span>HIGH</span><span>${config.label}</span>${zeroNote}`;
      loading.hidden = true;
    }

    function selectState(stateCode) {
      selectedState = stateCode;
      const row = rows.find(item => item.state === stateCode);
      if (!row) return;
      const totals = stateTotals.get(stateCode).get(row.state_name);
      document.getElementById("region-popup-title").textContent = row.state_name;
      document.getElementById("region-listed-total").textContent = d3.format(",")(totals.listed);
      document.getElementById("region-operating-total").textContent = d3.format(",")(totals.operating);
      document.getElementById("region-county-count").textContent = `Across ${d3.format(",")(totals.counties)} counties in the dataset`;
      regionPopup.hidden = false;
      tooltip.hidden = true;
      summary.textContent = `${row.state_name}: ${d3.format(",")(totals.listed)} listed and ${d3.format(",")(totals.operating)} operating facilities.`;
      renderMap();
    }

    function clearSelectedState() {
      selectedState = null;
      regionPopup.hidden = true;
      summary.textContent = "Hover or tap a county to see its details.";
      renderMap();
    }

    function showCounty(event, county, metric, config) {
      const row = data.get(String(county.id).padStart(5, "0"));
      if (!row) return;
      const value = countyValue(county, metric);
      const valueText = value === null ? "No value for this measure" : config.format(value);
      const heading = document.createElement("strong");
      heading.textContent = `${row.county_name}, ${row.state}`;
      tooltip.replaceChildren(
        heading,
        document.createTextNode(`${valueText}\n${d3.format(",.0f")(Number(row.listed_facility_count))} listed · ${d3.format(",.0f")(Number(row.operating_facility_count))} operating`),
      );
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - 265))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(event.clientY + 14, window.innerHeight - 115))}px`;
      summary.textContent = `${row.county_name}, ${row.state} — ${valueText}.`;
    }

    measureOptions.forEach(option => {
      option.addEventListener("click", () => {
        measureOptions.forEach(button => button.setAttribute("aria-pressed", String(button === option)));
        tooltip.hidden = true;
        render();
      });
    });
    document.getElementById("region-popup-close").addEventListener("click", clearSelectedState);
    renderMap = render;
    new ResizeObserver(render).observe(stage);
    render();
  } catch (error) {
    console.error("Unable to load county map data:", error);
    loading.hidden = true;
    stage.innerHTML = '<div class="map-error">The county map could not load. Check your connection and confirm the dataset is available in the data folder.</div>';
    summary.textContent = "Map data could not be loaded.";
    legend.textContent = "";
  }
}

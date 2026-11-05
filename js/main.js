document.addEventListener("DOMContentLoaded", () => {
  const progress = document.getElementById("progress");

  window.addEventListener("scroll", () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = `${max > 0 ? window.scrollY / max * 100 : 0}%`;
  }, { passive: true });

  document.getElementById("clear-linked-selection").addEventListener("click", () => setLinkedCountySelection(null));
  initializeCountyMap();
  initializeStoryCharts();
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

function loadDependency(source, isLoaded) {
  if (isLoaded()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(() => finish(new Error(`Timed out loading ${source}`)), 12000);
    const finish = error => {
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve();
      }
    };

    script.src = source;
    script.onload = () => finish(isLoaded() ? null : new Error(`Dependency did not initialize: ${source}`));
    script.onerror = () => finish(new Error(`Failed to load ${source}`));
    document.head.append(script);
  });
}

let d3DependencyPromise;

function loadD3() {
  if (!d3DependencyPromise) {
    d3DependencyPromise = loadDependency("https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js", () => typeof window.d3 !== "undefined");
  }
  return d3DependencyPromise;
}

let linkedCountySelection = null;
const linkedCountySelectionListeners = new Set();

function setLinkedCountySelection(row) {
  linkedCountySelection = row ? {
    fips: String(row.county_fips).padStart(5, "0"),
    state: row.state,
    countyName: row.county_name,
    stateName: row.state_name,
    rucc: Number(row.rucc_2023),
  } : null;
  document.querySelector(".linking-guide")?.classList.toggle("has-linked-selection", Boolean(linkedCountySelection));
  linkedCountySelectionListeners.forEach(listener => listener(linkedCountySelection));
}

function toggleLinkedCountySelection(row) {
  const fips = String(row.county_fips).padStart(5, "0");
  setLinkedCountySelection(linkedCountySelection?.fips === fips ? null : row);
}

function subscribeToLinkedCountySelection(listener) {
  linkedCountySelectionListeners.add(listener);
  listener(linkedCountySelection);
}

async function initializeCountyMap() {
  const stage = document.getElementById("map-stage");
  const loading = document.getElementById("map-loading");
  const measureOptions = document.querySelectorAll(".map-measure-option");
  const tooltip = document.getElementById("map-tooltip");
  const regionPopup = document.getElementById("region-popup");
  const summary = document.getElementById("map-summary");
  const legend = document.getElementById("map-legend");
  let selectedState = null;
  let selectedCountyFips = null;
  let renderMap = () => {};

  try {
    await Promise.all([
      loadD3(),
      loadDependency("https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js", () => typeof window.topojson !== "undefined"),
    ]);

    const svg = d3.select("#county-map");
    const controller = new AbortController();
    const dataTimeout = setTimeout(() => controller.abort(), 20000);
    let rows;
    let topology;
    try {
      [rows, topology] = await Promise.all([
        d3.csv("data/cleaned_dataset_with_water(in).csv", { signal: controller.signal }),
        d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json", { signal: controller.signal }),
      ]);
    } finally {
      clearTimeout(dataTimeout);
    }
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
      svg
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("height", height)
        .classed("has-linked-selection", Boolean(linkedCountySelection));
      svg.selectAll("path")
        .data(counties, county => county.id)
        .join("path")
        .attr("class", "county")
        .attr("data-county-fips", county => String(county.id).padStart(5, "0"))
        .classed("state-selected", county => {
          const row = data.get(String(county.id).padStart(5, "0"));
          return Boolean(selectedState && row?.state === selectedState);
        })
        .classed("county-linked-selected", county => String(county.id).padStart(5, "0") === selectedCountyFips)
        .attr("d", path)
        .attr("fill", county => {
          const value = countyValue(county, metric);
          return value === null ? "#101827" : color(value);
        })
        .on("pointerenter pointermove", (event, county) => showCounty(event, county, metric, config))
        .on("click", (event, county) => {
          const row = data.get(String(county.id).padStart(5, "0"));
          if (row) toggleLinkedCountySelection(row);
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
      setLinkedCountySelection(null);
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
    subscribeToLinkedCountySelection(selection => {
      selectedCountyFips = selection?.fips ?? null;
      if (selection) {
        selectState(selection.state);
      } else {
        selectedState = null;
        regionPopup.hidden = true;
        summary.textContent = "Hover or tap a county to see its details.";
        renderMap();
      }
    });
    new ResizeObserver(render).observe(stage);
    render();
  } catch (error) {
    console.error("Unable to load county map data:", error);
    loading.hidden = true;
    stage.innerHTML = '<div class="map-error">The county map could not load. Check your internet connection and reload the page to try again.<br><button class="map-retry" type="button">Reload map</button></div>';
    stage.querySelector(".map-retry").addEventListener("click", () => window.location.reload());
    summary.textContent = "Map data could not be loaded.";
    legend.textContent = "";
  }
}

const ruralUrbanCategories = [
  { code: 1, title: "Large metro", detail: "1m+ population" },
  { code: 2, title: "Mid-size metro", detail: "250k–1m population" },
  { code: 3, title: "Small metro", detail: "Under 250k" },
  { code: 4, title: "Micropolitan", detail: "20k+ · adjacent to metro" },
  { code: 5, title: "Micropolitan", detail: "20k+ · not adjacent" },
  { code: 6, title: "Small urban", detail: "5k–20k · adjacent to metro" },
  { code: 7, title: "Small urban", detail: "5k–20k · not adjacent" },
  { code: 8, title: "Rural", detail: "Under 5k · adjacent to metro" },
  { code: 9, title: "Rural", detail: "Under 5k · not adjacent" },
];

const storyFactors = {
  median_household_income_2024_usd: {
    label: "Median household income",
    format: value => `$${d3.format(",.0f")(value)}`,
  },
};

async function initializeStoryCharts() {
  const stages = [
    document.getElementById("rural-chart-stage"),
    document.getElementById("factor-chart-stage"),
    document.getElementById("service-line-chart-stage"),
    document.getElementById("water-stress-chart-stage"),
  ];

  try {
    await loadD3();
    const controller = new AbortController();
    const dataTimeout = setTimeout(() => controller.abort(), 20000);
    let rows;
    try {
      rows = await d3.csv("data/cleaned_dataset_with_water(in).csv", { signal: controller.signal });
    } finally {
      clearTimeout(dataTimeout);
    }

    const ruralSvg = d3.select("#rural-chart");
    const factorSvg = d3.select("#factor-chart");
    const serviceLineSvg = d3.select("#service-line-chart");
    const waterStressSvg = d3.select("#water-stress-chart");
    const ruralStage = stages[0];
    const factorStage = stages[1];
    const serviceLineStage = stages[2];
    const waterStressStage = stages[3];
    const ruralTooltip = createStoryTooltip(ruralStage);
    const factorTooltip = createStoryTooltip(factorStage);
    const serviceLineTooltip = createStoryTooltip(serviceLineStage);
    const waterStressTooltip = createStoryTooltip(waterStressStage);
    const ruralSummary = document.getElementById("rural-chart-summary");
    const factorSummary = document.getElementById("factor-chart-summary");
    const serviceLineSummary = document.getElementById("service-line-chart-summary");
    const waterStressSummary = document.getElementById("water-stress-chart-summary");
    let ruralMetric = "listed";
    let factorMetric = "listed";
    let serviceLineMetric = "listed";

    function renderRuralChart() {
      const width = ruralStage.clientWidth;
      if (!width) return;
      const metricField = ruralMetric === "listed" ? "listed_facility_count" : "operating_facility_count";
      const measureName = ruralMetric === "listed" ? "listed" : "operating";
      const values = ruralUrbanCategories.map(category => {
        const categoryRows = rows.filter(row => Number(row.rucc_2023) === category.code);
        const facilityTotal = d3.sum(categoryRows, row => Number(row[metricField]) || 0);
        const countiesWithFacilities = categoryRows.filter(row => Number(row[metricField]) > 0).length;
        return {
          ...category,
          description: categoryRows[0]?.rucc_description || "",
          counties: categoryRows.length,
          facilityTotal,
          countiesWithFacilities,
          rate: categoryRows.length ? countiesWithFacilities / categoryRows.length : 0,
        };
      });
      const margin = { top: 20, right: 70, bottom: 56, left: Math.min(220, Math.max(155, width * 0.38)) };
      const height = 468;
      const plotWidth = Math.max(40, width - margin.left - margin.right);
      const plotHeight = height - margin.top - margin.bottom;
      const x = d3.scaleLinear()
        .domain([0, d3.max(values, value => value.rate) || 0.1])
        .nice()
        .range([0, plotWidth]);
      const y = d3.scaleBand()
        .domain(values.map(value => value.code))
        .range([0, plotHeight])
        .padding(0.28);
      const chart = ruralSvg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
      chart.selectAll("*").remove();
      const plot = chart.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

      plot.append("g")
        .attr("class", "story-grid")
        .attr("transform", `translate(0,${plotHeight})`)
        .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format(".0%")).tickSize(-plotHeight).tickPadding(10));

      plot.append("g")
        .attr("class", "story-axis")
        .call(d3.axisLeft(y).tickFormat(() => "").tickSize(0));
      plot.selectAll(".domain").remove();

      const groups = plot.selectAll(".rural-row")
        .data(values)
        .join("g")
        .attr("class", "rural-row")
        .attr("transform", value => `translate(0,${y(value.code)})`);

      groups.append("text")
        .attr("class", "rural-category-label")
        .attr("x", -12)
        .attr("y", y.bandwidth() / 2 - 2)
        .attr("text-anchor", "end")
        .each(function(value) {
          const label = d3.select(this);
          label.append("tspan").attr("x", -12).text(`${value.code} · ${value.title}`);
          label.append("tspan").attr("class", "rural-category-detail").attr("x", -12).attr("dy", 14).text(value.detail);
        });

      const bars = groups.append("rect")
        .attr("class", value => `rural-bar ${value.code <= 3 ? "metro-bar" : "nonmetro-bar"}`)
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", value => x(value.rate))
        .attr("height", y.bandwidth())
        .attr("rx", 3)
        .attr("aria-label", value => `${value.description}: ${d3.format(".1%")(value.rate)} of ${value.counties} counties have at least one ${measureName} facility`);

      groups.append("text")
        .attr("class", "rural-rate-label")
        .attr("x", value => x(value.rate) + 8)
        .attr("y", y.bandwidth() / 2 + 4)
        .text(value => d3.format(".1%")(value.rate));

      const showValue = (event, value) => {
        const message = `${value.description}: ${d3.format(".1%")(value.rate)} of counties (${value.countiesWithFacilities}/${value.counties}) have at least one ${measureName} facility. ${d3.format(",")(value.facilityTotal)} ${measureName} facilities in total.`;
        ruralSummary.textContent = message;
        showStoryTooltip(ruralTooltip, ruralStage, event, [
          value.description,
          `${d3.format(".1%")(value.rate)} of counties (${value.countiesWithFacilities}/${value.counties})`,
          `${d3.format(",")(value.facilityTotal)} ${measureName} facilities`,
        ]);
      };
      bars
        .on("pointerenter pointermove", showValue)
        .on("focus", showValue)
        .on("pointerleave blur", () => { ruralTooltip.hidden = true; });
      plot.append("text")
        .attr("class", "story-axis-title")
        .attr("x", plotWidth / 2)
        .attr("y", plotHeight + 44)
        .attr("text-anchor", "middle")
        .text(`Counties with ≥1 ${measureName} facility`);

      const totalCounties = d3.sum(values, value => value.counties);
      const totalWithFacilities = d3.sum(values, value => value.countiesWithFacilities);
      ruralSummary.textContent = `${d3.format(",")(totalWithFacilities)} of ${d3.format(",")(totalCounties)} counties (${d3.format(".1%")(totalWithFacilities / totalCounties)}) have at least one ${measureName} facility.`;
      document.getElementById("rural-chart-loading").hidden = true;
      syncSelectionHighlights();
    }

    function renderFactorChart() {
      const width = factorStage.clientWidth;
      if (!width) return;
      const factorKey = "median_household_income_2024_usd";
      const factor = storyFactors[factorKey];
      const metricField = factorMetric === "listed" ? "listed_facility_count" : "operating_facility_count";
      const measureName = factorMetric === "listed" ? "listed" : "operating";
      const validRows = rows
        .map(row => ({ row, value: Number(row[factorKey]), facilities: Number(row[metricField]) || 0 }))
        .filter(item => item.row[factorKey] !== "" && Number.isFinite(item.value));
      const sortedValues = validRows.map(item => item.value).sort(d3.ascending);
      if (!sortedValues.length) throw new Error(`No county values are available for ${factor.label}.`);
      const min = d3.min(sortedValues);
      const max = d3.max(sortedValues);
      const thresholds = d3.range(1, 10)
        .map(index => d3.quantileSorted(sortedValues, index / 10))
        .filter((value, index, values) => value > min && value < max && (index === 0 || value > values[index - 1]));
      const bins = d3.bin()
        .value(item => item.value)
        .domain([min, max])
        .thresholds(thresholds)(validRows)
        .filter(bin => bin.length > 0)
        .map((bin, index) => ({
          index: index + 1,
          x0: bin.x0,
          x1: bin.x1,
          counties: bin.length,
          countyFips: bin.map(item => String(item.row.county_fips).padStart(5, "0")),
          countiesWithFacilities: bin.filter(item => item.facilities > 0).length,
          facilityTotal: d3.sum(bin, item => item.facilities),
          rate: bin.filter(item => item.facilities > 0).length / bin.length,
        }));
      const margin = { top: 28, right: 28, bottom: 94, left: 76 };
      const height = 420;
      const plotWidth = Math.max(60, width - margin.left - margin.right);
      const plotHeight = height - margin.top - margin.bottom;
      const overallRate = d3.sum(validRows, item => item.facilities > 0 ? 1 : 0) / validRows.length;
      const maxRate = d3.max(bins, bin => bin.rate) || 0;
      const y = d3.scaleLinear()
        .domain([0, Math.max(0.1, maxRate, overallRate) * 1.12])
        .nice()
        .range([plotHeight, 0]);
      const x = d3.scalePoint()
        .domain(bins.map(bin => bin.index))
        .range([0, plotWidth])
        .padding(bins.length === 1 ? 0.5 : 0.25);
      const chart = factorSvg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
      chart.selectAll("*").remove();
      const plot = chart.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

      plot.append("g")
        .attr("class", "story-grid")
        .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".0%")).tickSize(-plotWidth).tickPadding(9));
      plot.append("g")
        .attr("class", "story-axis")
        .attr("transform", `translate(0,${plotHeight})`)
        .call(d3.axisBottom(x).tickFormat(index => `${index}`).tickSize(0).tickPadding(10));

      plot.append("line")
        .attr("class", "overall-rate-line")
        .attr("x1", 0)
        .attr("x2", plotWidth)
        .attr("y1", y(overallRate))
        .attr("y2", y(overallRate));
      plot.append("text")
        .attr("class", "overall-rate-label")
        .attr("x", plotWidth - 3)
        .attr("y", -12)
        .attr("text-anchor", "end")
        .text(`Valid-data overall · ${d3.format(".1%")(overallRate)}`);

      plot.append("path")
        .datum(bins)
        .attr("class", "factor-trend")
        .attr("d", d3.line().x(bin => x(bin.index)).y(bin => y(bin.rate)).curve(d3.curveMonotoneX));

      const showValue = (event, bin) => {
        const low = factor.format(bin.x0);
        const high = factor.format(bin.x1 ?? max);
        const message = `${factor.label}, group ${bin.index} of ${bins.length} (${low} to ${high}): ${d3.format(".1%")(bin.rate)} of counties (${bin.countiesWithFacilities}/${bin.counties}) have at least one ${measureName} facility.`;
        factorSummary.textContent = message;
        showStoryTooltip(factorTooltip, factorStage, event, [
          `${factor.label} · group ${bin.index} of ${bins.length}`,
          `${low} to ${high}`,
          `${d3.format(".1%")(bin.rate)} of counties (${bin.countiesWithFacilities}/${bin.counties})`,
          `${d3.format(",")(bin.facilityTotal)} ${measureName} facilities`,
        ]);
      };
      plot.selectAll(".factor-point")
        .data(bins)
        .join("circle")
        .attr("class", "factor-point")
        .attr("data-income-group", bin => bin.index)
        .attr("cx", bin => x(bin.index))
        .attr("cy", bin => y(bin.rate))
        .attr("r", 6)
        .attr("tabindex", 0)
        .attr("role", "img")
        .attr("aria-label", bin => `${factor.label}, group ${bin.index} of ${bins.length}: ${d3.format(".1%")(bin.rate)} of ${bin.counties} counties have at least one ${measureName} facility`)
        .on("pointerenter pointermove", showValue)
        .on("focus", showValue)
        .on("pointerleave blur", () => { factorTooltip.hidden = true; });

      plot.append("text")
        .attr("class", "factor-end-label")
        .attr("x", 0)
        .attr("y", plotHeight + 34)
        .attr("text-anchor", "start")
        .text("LOWER VALUES");
      plot.append("text")
        .attr("class", "factor-end-label")
        .attr("x", plotWidth)
        .attr("y", plotHeight + 34)
        .attr("text-anchor", "end")
        .text("HIGHER VALUES");
      chart.append("text")
        .attr("class", "story-axis-title")
        .attr("x", margin.left + plotWidth / 2)
        .attr("y", height - 12)
        .attr("text-anchor", "middle")
        .text(`${factor.label} · county quantile groups`);
      chart.append("text")
        .attr("class", "story-y-axis-title")
        .attr("transform", `translate(18,${margin.top + plotHeight / 2}) rotate(-90)`)
        .attr("text-anchor", "middle")
        .text(`Counties with ≥1 ${measureName} facility`);

      factorSummary.textContent = `${d3.format(",")(validRows.length)} counties with reported ${factor.label.toLowerCase()}; ${d3.format(".1%")(overallRate)} have at least one ${measureName} facility. Missing factor values are excluded.`;
      document.getElementById("factor-chart-loading").hidden = true;
      syncSelectionHighlights();
    }

    function renderServiceLineChart() {
      const width = serviceLineStage.clientWidth;
      if (!width) return;
      const metricField = serviceLineMetric === "listed" ? "listed_facility_count" : "operating_facility_count";
      const measureName = serviceLineMetric === "listed" ? "listed" : "operating";
      const values = rows
        .filter(row => row.median_facility_to_in_service_line_miles_est !== "")
        .map(row => ({
          row,
          distance: Number(row.median_facility_to_in_service_line_miles_est),
          facilities: Number(row[metricField]),
        }))
        .filter(item => Number.isFinite(item.distance) && item.distance > 0 && Number.isFinite(item.facilities));
      if (!values.length) throw new Error("No county line-distance estimates are available.");

      const margin = { top: 28, right: 24, bottom: 76, left: 76 };
      const height = 440;
      const plotWidth = Math.max(50, width - margin.left - margin.right);
      const plotHeight = height - margin.top - margin.bottom;
      const minDistance = d3.min(values, item => item.distance);
      const maxDistance = d3.max(values, item => item.distance);
      const x = d3.scaleLog().domain([minDistance / 1.15, maxDistance * 1.15]).range([0, plotWidth]);
      const maxFacilities = d3.max(values, item => item.facilities);
      const y = d3.scaleLinear().domain([0, maxFacilities]).nice().range([plotHeight, 0]);
      const xTicks = [0.001, 0.01, 0.1, 1, 10, 100].filter(value => value >= minDistance && value <= maxDistance);
      const chart = serviceLineSvg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
      chart.selectAll("*").remove();
      chart.append("title").text("County facility counts by estimated median distance to an in-service line");
      chart.append("desc").text(`${values.length} counties with distance data. The horizontal axis is logarithmic from ${d3.format(".3~g")(minDistance)} to ${d3.format(".3~g")(maxDistance)} miles; the vertical axis shows the selected county facility count from zero. Points may overlap.`);
      const plot = chart.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

      plot.append("g")
        .attr("class", "story-grid")
        .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(",.0f")).tickSize(-plotWidth).tickPadding(9));
      plot.append("g")
        .attr("class", "story-grid")
        .attr("transform", `translate(0,${plotHeight})`)
        .call(d3.axisBottom(x).tickValues(xTicks).tickFormat(d3.format(".3~g")).tickSize(-plotHeight).tickPadding(9));
      plot.selectAll(".domain").remove();

      const showValue = (event, item) => {
        const distanceText = d3.format(".3~g")(item.distance);
        const facilityLabel = item.facilities === 1 ? "facility" : "facilities";
        const message = `${item.row.county_name}, ${item.row.state_name}: ${d3.format(",")(item.facilities)} ${measureName} ${facilityLabel}; county median estimated distance to an in-service line is ${distanceText} miles.`;
        serviceLineSummary.textContent = message;
        showStoryTooltip(serviceLineTooltip, serviceLineStage, event, [
          `${item.row.county_name}, ${item.row.state_name}`,
          `${d3.format(",")(item.facilities)} ${measureName} ${facilityLabel}`,
          `${distanceText} miles · county median estimated distance`,
        ]);
      };

      plot.selectAll(".service-line-point")
        .data(values)
        .join("circle")
        .attr("class", "service-line-point")
        .attr("data-county-fips", item => String(item.row.county_fips).padStart(5, "0"))
        .attr("cx", item => x(item.distance))
        .attr("cy", item => y(item.facilities))
        .attr("r", 4)
        .attr("pointer-events", "none")
        .attr("tabindex", 0)
        .attr("role", "button")
        .attr("aria-label", item => `${item.row.county_name}, ${item.row.state_name}: select county`)
        .on("click", (event, item) => toggleLinkedCountySelection(item.row))
        .on("keydown", (event, item) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleLinkedCountySelection(item.row);
          }
        });

      const delaunay = d3.Delaunay.from(values, item => x(item.distance), item => y(item.facilities));
      plot.append("rect")
        .attr("class", "service-line-interaction")
        .attr("width", plotWidth)
        .attr("height", plotHeight)
        .attr("fill", "transparent")
        .on("pointermove", event => {
          const [pointerX, pointerY] = d3.pointer(event, plot.node());
          const index = delaunay.find(pointerX, pointerY);
          const pointX = delaunay.points[index * 2];
          const pointY = delaunay.points[index * 2 + 1];
          if (Math.hypot(pointerX - pointX, pointerY - pointY) > 18) {
            serviceLineTooltip.hidden = true;
            return;
          }
          showValue(event, values[index]);
        })
        .on("click", event => {
          const [pointerX, pointerY] = d3.pointer(event, plot.node());
          const index = delaunay.find(pointerX, pointerY);
          const pointX = delaunay.points[index * 2];
          const pointY = delaunay.points[index * 2 + 1];
          if (Math.hypot(pointerX - pointX, pointerY - pointY) <= 18) {
            toggleLinkedCountySelection(values[index].row);
          }
        })
        .on("pointerleave", () => { serviceLineTooltip.hidden = true; });

      chart.append("text")
        .attr("class", "story-axis-title")
        .attr("x", margin.left + plotWidth / 2)
        .attr("y", height - 12)
        .attr("text-anchor", "middle")
        .text("Estimated line distance (miles · log scale)");
      chart.append("text")
        .attr("class", "story-y-axis-title")
        .attr("transform", `translate(18,${margin.top + plotHeight / 2}) rotate(-90)`)
        .attr("text-anchor", "middle")
        .text(`${measureName[0].toUpperCase()}${measureName.slice(1)} facilities per county`);

      serviceLineSummary.textContent = `Each point is one of ${d3.format(",")(values.length)} counties with a reported line-distance estimate (range ${d3.format(".3~g")(minDistance)}–${d3.format(".3~g")(maxDistance)} miles), out of ${d3.format(",")(rows.length)} counties in the dataset. Points may overlap.`;
      document.getElementById("service-line-chart-loading").hidden = true;
      syncSelectionHighlights();
    }

    function renderWaterStressChart() {
      const width = waterStressStage.clientWidth;
      if (!width) return;
      const validRows = rows.filter(row => row.water_stress_huc_mean !== "" && Number.isFinite(Number(row.water_stress_huc_mean)));
      const countyRowsByState = d3.group(rows, row => row.state);
      const stateValues = Array.from(d3.group(validRows, row => row.state), ([state, stateRows]) => {
        const allStateRows = countyRowsByState.get(state);
        return {
          state,
          stateName: stateRows[0].state_name,
          countyCount: stateRows.length,
          datasetCountyCount: allStateRows.length,
          waterStress: d3.mean(stateRows, row => Number(row.water_stress_huc_mean)),
          operatingFacilities: d3.sum(stateRows, row => Number(row.operating_facility_count) || 0),
        };
      }).filter(value => value.operatingFacilities > 0);
      if (!stateValues.length) throw new Error("No county water-stress values are available.");

      const height = 500;
      const legendHeight = 75;
      const pack = d3.pack()
        .size([width, height - legendHeight])
        .padding(width < 500 ? 3 : 6);
      const root = d3.hierarchy({ children: stateValues })
        .sum(value => value.operatingFacilities || 0)
        .sort((a, b) => b.value - a.value);
      const bubbles = pack(root).leaves();
      const color = d3.scaleSequential(d3.interpolateCividis).domain([0, 1]);
      const chart = waterStressSvg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
      chart.selectAll("*").remove();
      chart.append("title").text("State operating-facility counts and mean county water stress");
      chart.append("desc").text(`${stateValues.length} state and DC bubbles with reported water-stress data and at least one operating facility. Bubble area is proportional to the operating-facility count among counties with stress data. Bubble color encodes the unweighted mean county water-stress indicator on a fixed scale from zero to one.`);
      const nodes = chart.selectAll(".water-stress-bubble")
        .data(bubbles, bubble => bubble.data.state)
        .join("g")
        .attr("class", "water-stress-bubble")
        .attr("data-state", bubble => bubble.data.state)
        .attr("transform", bubble => `translate(${bubble.x},${bubble.y})`);

      nodes.append("circle")
        .attr("class", "water-stress-circle")
        .attr("r", bubble => bubble.r)
        .attr("fill", bubble => color(bubble.data.waterStress))
        .attr("tabindex", 0)
        .attr("role", "img")
        .attr("aria-label", bubble => `${bubble.data.stateName}: ${d3.format(",")(bubble.data.operatingFacilities)} operating facilities in counties with reported stress; mean county water-stress indicator ${d3.format(".2f")(bubble.data.waterStress)} from ${bubble.data.countyCount} of ${bubble.data.datasetCountyCount} counties`)
        .on("pointerenter pointermove", (event, bubble) => showWaterStressValue(event, bubble.data))
        .on("focus", (event, bubble) => showWaterStressValue(event, bubble.data))
        .on("pointerleave", event => {
          if (document.activeElement !== event.currentTarget) waterStressTooltip.hidden = true;
        })
        .on("blur", () => { waterStressTooltip.hidden = true; });

      nodes.filter(bubble => bubble.r >= 12)
        .append("text")
        .attr("class", "water-stress-bubble-label")
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .style("font-size", bubble => `${Math.min(12, Math.max(8, bubble.r * 0.72))}px`)
        .text(bubble => bubble.data.state);

      function showWaterStressValue(event, value) {
        const message = `${value.stateName}: mean county water-stress indicator ${d3.format(".2f")(value.waterStress)}; ${d3.format(",")(value.operatingFacilities)} operating facilities among ${d3.format(",")(value.countyCount)} counties with reported stress (${d3.format(",")(value.datasetCountyCount)} counties in the dataset).`;
        waterStressSummary.textContent = message;
        showStoryTooltip(waterStressTooltip, waterStressStage, event, [
          value.stateName,
          `Mean county water-stress indicator: ${d3.format(".2f")(value.waterStress)}`,
          `${d3.format(",")(value.operatingFacilities)} operating facilities in counties with data`,
          `Water stress reported for ${d3.format(",")(value.countyCount)} of ${d3.format(",")(value.datasetCountyCount)} counties`,
        ]);
      }

      const legend = chart.append("g")
        .attr("class", "water-stress-legend")
        .attr("transform", `translate(16,${height - legendHeight + 7})`);
      const gradientId = "water-stress-color-scale";
      const gradient = chart.append("defs")
        .append("linearGradient")
        .attr("id", gradientId)
        .attr("x1", "0%")
        .attr("x2", "100%");
      d3.range(0, 1.01, 0.2).forEach(value => {
        gradient.append("stop")
          .attr("offset", `${value * 100}%`)
          .attr("stop-color", color(value));
      });
      legend.append("text")
        .attr("class", "water-stress-legend-title")
        .attr("x", 0)
        .attr("y", 0)
        .text("STATE MEAN WATER STRESS");
      legend.append("rect")
        .attr("x", 0)
        .attr("y", 8)
        .attr("width", Math.min(140, width * 0.42))
        .attr("height", 8)
        .attr("rx", 4)
        .attr("fill", `url(#${gradientId})`);
      legend.append("text")
        .attr("class", "water-stress-legend-label")
        .attr("x", 0)
        .attr("y", 29)
        .text("0 · LOWER");
      legend.append("text")
        .attr("class", "water-stress-legend-label")
        .attr("x", Math.min(140, width * 0.42))
        .attr("y", 29)
        .attr("text-anchor", "end")
        .text("1 · HIGHER");
      legend.append("text")
        .attr("class", "water-stress-legend-title")
        .attr("x", width < 500 ? 150 : 190)
        .attr("y", 15)
        .text("AREA ∝ OPERATING COUNT");

      const countiesWithStress = validRows.length;
      const jurisdictionsWithData = new Set(validRows.map(row => row.state)).size;
      const zeroFacilityJurisdictions = jurisdictionsWithData - stateValues.length;
      waterStressSummary.textContent = `Stress values are reported for ${d3.format(",")(countiesWithStress)} of ${d3.format(",")(rows.length)} dataset counties across ${jurisdictionsWithData} jurisdictions. Bubbles show ${stateValues.length} jurisdictions with at least one operating facility.${zeroFacilityJurisdictions ? ` ${zeroFacilityJurisdictions} jurisdictions with stress data and zero operating facilities are omitted.` : ""}`;
      document.getElementById("water-stress-chart-loading").hidden = true;
      syncSelectionHighlights();
    }

    function syncSelectionHighlights() {
      const selection = linkedCountySelection;
      ruralSvg.classed("has-linked-selection", Boolean(selection));
      factorSvg.classed("has-linked-selection", Boolean(selection));
      serviceLineSvg.classed("has-linked-selection", Boolean(selection));
      waterStressSvg.classed("has-linked-selection", Boolean(selection));
      ruralSvg.selectAll(".rural-bar")
        .classed("is-linked-selection", value => Boolean(selection && Number(selection.rucc) === value.code));
      factorSvg.selectAll(".factor-point")
        .classed("is-linked-selection", bin => Boolean(selection && bin.countyFips.includes(selection.fips)));
      serviceLineSvg.selectAll(".service-line-point")
        .classed("is-linked-selection", item => Boolean(selection && String(item.row.county_fips).padStart(5, "0") === selection.fips));
      waterStressSvg.selectAll(".water-stress-bubble")
        .classed("is-linked-selection", bubble => Boolean(selection && bubble.data.state === selection.state));
    }

    subscribeToLinkedCountySelection(syncSelectionHighlights);

    document.querySelectorAll(".rural-metric-option").forEach(button => {
      button.addEventListener("click", () => {
        ruralMetric = button.dataset.metric;
        document.querySelectorAll(".rural-metric-option").forEach(option => option.setAttribute("aria-pressed", String(option === button)));
        ruralTooltip.hidden = true;
        renderRuralChart();
      });
    });
    document.querySelectorAll(".factor-metric-option").forEach(button => {
      button.addEventListener("click", () => {
        factorMetric = button.dataset.metric;
        document.querySelectorAll(".factor-metric-option").forEach(option => option.setAttribute("aria-pressed", String(option === button)));
        factorTooltip.hidden = true;
        renderFactorChart();
      });
    });
    document.querySelectorAll(".line-metric-option").forEach(button => {
      button.addEventListener("click", () => {
        serviceLineMetric = button.dataset.metric;
        document.querySelectorAll(".line-metric-option").forEach(option => option.setAttribute("aria-pressed", String(option === button)));
        serviceLineTooltip.hidden = true;
        renderServiceLineChart();
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      renderRuralChart();
      renderFactorChart();
      renderServiceLineChart();
      renderWaterStressChart();
    });
    stages.forEach(stage => resizeObserver.observe(stage));
    renderRuralChart();
    renderFactorChart();
    renderServiceLineChart();
    renderWaterStressChart();
  } catch (error) {
    console.error("Unable to load story chart data:", error);
    stages.forEach(stage => {
      const loading = stage.querySelector(".story-chart-loading");
      loading.textContent = "The chart could not load. Check your connection and reload the page to try again.";
      loading.classList.add("story-chart-error");
    });
    document.getElementById("rural-chart-summary").textContent = "County data could not be loaded.";
    document.getElementById("factor-chart-summary").textContent = "County data could not be loaded.";
    document.getElementById("service-line-chart-summary").textContent = "County data could not be loaded.";
    document.getElementById("water-stress-chart-summary").textContent = "County data could not be loaded.";
  }
}

function createStoryTooltip(stage) {
  const tooltip = document.createElement("div");
  tooltip.className = "story-chart-tooltip";
  tooltip.setAttribute("role", "status");
  tooltip.hidden = true;
  stage.append(tooltip);
  return tooltip;
}

function showStoryTooltip(tooltip, stage, event, lines) {
  let [pointerX, pointerY] = d3.pointer(event, stage);
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) {
    const targetBounds = event.target.getBoundingClientRect();
    const stageBounds = stage.getBoundingClientRect();
    pointerX = targetBounds.left + targetBounds.width / 2 - stageBounds.left;
    pointerY = targetBounds.top + targetBounds.height / 2 - stageBounds.top;
  }
  tooltip.replaceChildren(...lines.map((line, index) => {
    const element = document.createElement(index === 0 ? "strong" : "span");
    element.textContent = line;
    return element;
  }));
  tooltip.hidden = false;
  tooltip.style.left = `${Math.max(8, Math.min(pointerX + 14, stage.clientWidth - tooltip.offsetWidth - 8))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(pointerY + 14, stage.clientHeight - tooltip.offsetHeight - 8))}px`;
}

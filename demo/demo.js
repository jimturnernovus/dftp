// Demo page behaviour: invented data, search, status chips, date and amount
// filters, paging, row details and the theme switch. Everything happens in
// this page; nothing is sent anywhere.

(() => {
  const BUSINESSES = [
    "Juniper Street Bakery", "Halcyon Auto Glass", "Copperleaf Dental Studio", "Bluewater Laundry Co.",
    "Maple & Thistle Florist", "Northgate Bike Works", "Cardamom Table Catering", "Pinecrest Pet Grooming",
    "Lantern Bay Bookshop", "Riverside Print House", "Golden Hour Photo Lab", "Cedar Lane Hardware",
    "Old Mill Coffee Roasters", "Summit Climbing Gym", "Brightwell Tutoring", "Quarry Hill Pottery",
    "Orchard Row Pharmacy", "Seaside Surf Rentals", "Kestrel Courier Service", "Willow Creek Yoga",
    "Hollow Oak Furniture", "Marigold Nail Studio", "Foxglove Tea House", "Sandpiper Swim School",
    "Granite Peak Plumbing", "Larkspur Music Lessons", "Tidewater Fish Market", "Silver Birch Spa",
    "Wildflower Daycare", "Harbor Light Optics", "Blue Gull Kayaks", "Firefly Arcade",
    "Meadowbrook Vet Clinic", "Stonebridge Tailors", "Thornfield Landscaping", "Clover Hill Creamery",
    "Driftwood Gallery", "Evergreen Tax Prep", "Bramble & Bee Honey Co.", "Westwind Sailing Club",
    "Moonlit Bakehouse", "Ashford Shoe Repair", "Pebble Cove Rentals", "Rosewood Piano Tuning",
    "Gull Point Marina", "Canyon Ridge Fitness", "Hearthstone Pizza", "Bellflower Stationery",
  ];
  const CONTACTS = [
    "Priya Natarajan", "Tomas Lindqvist", "Grace Okafor", "Mateo Alvarez", "Hana Suzuki", "Olivia Brennan",
    "Kwame Mensah", "Sofia Rossi", "Liam Fitzgerald", "Amara Diallo", "Noah Bergstrom", "Elena Petrova",
    "Felix Wagner", "Imani Carter", "Lucas Moreau", "Mei Lin", "Oscar Haugen", "Zara Ahmed",
    "Theo Lambert", "Nadia Haddad", "Rafael Costa", "Ingrid Solberg", "Kofi Asante", "Lena Hoffmann",
    "Marco Bianchi", "Aisha Rahman", "Jonas Weber", "Freya Lund", "Diego Herrera", "Yuki Tanaka",
    "Samuel Osei", "Clara Dupont", "Arjun Mehta", "Nora Quinn", "Viktor Ilic", "Leila Farahani",
    "Henrik Dahl", "Maya Goldberg", "Emil Strand", "Talia Brooks", "Kenji Watanabe", "Wren Abernathy",
    "Pavel Horak", "Chloe Martin", "Iris Fontaine", "Malik Jensen", "Greta Vogel", "Owen Price",
  ];
  const CITIES = ["Brookfield", "Fairhaven", "Millbrook", "Easton", "Lakeview", "Westport", "Ashby", "Glenwood"];
  const PLANS = [["Starter", 450], ["Standard", 900], ["Plus", 1200], ["Growth", 1800], ["Pro", 2400], ["Enterprise", 3200]];
  const OWNERS = ["A. Rivera", "K. Lindholm", "S. Okoye", "M. Castell"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const STATUS_LABEL = { active: "Active", trial: "Trial", paused: "Paused", overdue: "Overdue" };
  const PER_PAGE = 12;

  // Forty-eight invented clients, the same every time the page loads.
  const clients = BUSINESSES.map((name, i) => {
    const [plan, monthly] = PLANS[(i * 5 + 2) % PLANS.length];
    const year = 2023 + (i % 3);
    const month = ((i * 7) % 12) + 1;
    const day = ((i * 11) % 27) + 1;
    const monthsOn = Math.max(1, (2026 - year) * 12 + (9 - month));
    const status = i % 11 === 4 ? "overdue" : i % 7 === 3 ? "paused" : i % 9 === 6 ? "trial" : "active";
    const contact = CONTACTS[i];
    return {
      id: `AC-${1001 + i * 3 + (i > 13 ? 1 : 0)}`,
      name,
      city: CITIES[i % CITIES.length],
      contact,
      email: `${contact.split(" ")[0].toLowerCase()}@example.com`,
      phone: `555-01${String(i).padStart(2, "0")}`,
      year,
      month,
      started: `${MONTHS[month - 1]} ${day}, ${year}`,
      plan,
      monthly,
      billed: status === "trial" ? 0 : monthly * Math.min(monthsOn, 12 + (i % 9)),
      usage: (i * 37 + 18) % 101,
      status,
      owner: OWNERS[i % OWNERS.length],
      next: `${MONTHS[(i + 3) % 12]} 1`,
    };
  });

  const $ = (id) => document.getElementById(id);
  const money = (n) => `$${n.toLocaleString("en-US")}`;
  const state = { q: "", status: "all", month: "", year: "", mmin: null, mmax: null, bmin: null, bmax: null, page: 1, open: null };

  const num = (v) => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function matches(c) {
    const q = state.q.trim().toLowerCase();
    if (q && ![c.id, c.name, c.city, c.contact, c.phone].some((s) => s.toLowerCase().includes(q))) return false;
    if (state.status !== "all" && c.status !== state.status) return false;
    if (state.month && c.month !== Number(state.month)) return false;
    if (state.year && c.year !== Number(state.year)) return false;
    if (state.mmin !== null && c.monthly < state.mmin) return false;
    if (state.mmax !== null && c.monthly > state.mmax) return false;
    if (state.bmin !== null && c.billed < state.bmin) return false;
    if (state.bmax !== null && c.billed > state.bmax) return false;
    return true;
  }

  function fill(root, cls, text) {
    const n = root.querySelector(`.${cls}`);
    if (n) n.textContent = text;
    return n;
  }

  function rowFor(c) {
    const tr = $("row-template").content.firstElementChild.cloneNode(true);
    tr.dataset.client = c.id;
    fill(tr, "client-id", c.id);
    fill(tr, "biz-name", c.name);
    fill(tr, "biz-city", c.city);
    fill(tr, "contact", c.contact);
    fill(tr, "phone", c.phone);
    const t = fill(tr, "started", c.started);
    t.setAttribute("datetime", `${c.year}-${String(c.month).padStart(2, "0")}`);
    fill(tr, "monthly", money(c.monthly));
    fill(tr, "billed", money(c.billed));
    tr.querySelector(".bar-fill").style.width = `${c.usage}%`;
    fill(tr, "pct", `${c.usage}%`);
    const badge = fill(tr, "badge", STATUS_LABEL[c.status]);
    badge.classList.add(`badge-${c.status}`);
    if (state.open === c.id) tr.classList.add("is-open");
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".row-menu")) return;
      state.open = state.open === c.id ? null : c.id;
      render();
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      state.open = state.open === c.id ? null : c.id;
      render();
    });
    return tr;
  }

  function detailFor(c) {
    const tr = $("detail-template").content.firstElementChild.cloneNode(true);
    fill(tr, "d-plan", `${c.plan} · ${money(c.monthly)} a month`);
    fill(tr, "d-owner", c.owner);
    fill(tr, "d-next", c.next);
    fill(tr, "d-email", c.email);
    return tr;
  }

  function render() {
    const list = clients.filter(matches);
    const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * PER_PAGE;
    const shown = list.slice(start, start + PER_PAGE);
    const body = $("rows");
    const rows = [];
    for (const c of shown) {
      rows.push(rowFor(c));
      if (state.open === c.id) rows.push(detailFor(c));
    }
    body.replaceChildren(...rows);
    $("empty").hidden = list.length > 0;
    $("pager-info").textContent = list.length ? `${start + 1}–${start + shown.length} of ${list.length}` : "0 of 0";
    const nums = [];
    for (let p = 1; p <= pages; p++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `page-btn${p === state.page ? " is-on" : ""}`;
      b.textContent = String(p);
      b.setAttribute("aria-label", `Page ${p}`);
      if (p === state.page) b.setAttribute("aria-current", "page");
      b.addEventListener("click", () => {
        state.page = p;
        render();
      });
      nums.push(b);
    }
    $("pages").replaceChildren(...nums);
    $("prev").disabled = state.page <= 1;
    $("next").disabled = state.page >= pages;
    const active = [state.status !== "all", state.month, state.year, state.mmin !== null, state.mmax !== null, state.bmin !== null, state.bmax !== null].filter(Boolean).length;
    $("filter-count").textContent = String(active);
  }

  function note(text) {
    const n = $("demo-note");
    n.textContent = text;
    n.hidden = false;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => {
      n.hidden = true;
    }, 3000);
  }

  $("search").addEventListener("input", (e) => {
    state.q = e.target.value;
    state.page = 1;
    render();
  });
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      state.status = chip.dataset.status;
      state.page = 1;
      for (const c of document.querySelectorAll(".chip")) c.classList.toggle("is-on", c === chip);
      render();
    });
  }
  const bindNumber = (id, key) => $(id).addEventListener("input", (e) => {
    state[key] = num(e.target.value);
    state.page = 1;
    render();
  });
  bindNumber("f-monthly-min", "mmin");
  bindNumber("f-monthly-max", "mmax");
  bindNumber("f-billed-min", "bmin");
  bindNumber("f-billed-max", "bmax");
  $("f-month").addEventListener("change", (e) => {
    state.month = e.target.value;
    state.page = 1;
    render();
  });
  $("f-year").addEventListener("change", (e) => {
    state.year = e.target.value;
    state.page = 1;
    render();
  });
  $("f-clear").addEventListener("click", () => {
    Object.assign(state, { status: "all", month: "", year: "", mmin: null, mmax: null, bmin: null, bmax: null, page: 1 });
    for (const id of ["f-month", "f-year", "f-monthly-min", "f-monthly-max", "f-billed-min", "f-billed-max"]) $(id).value = "";
    for (const c of document.querySelectorAll(".chip")) c.classList.toggle("is-on", c.dataset.status === "all");
    render();
  });
  $("filters-toggle").addEventListener("click", (e) => {
    const panel = $("filters");
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
  });
  $("prev").addEventListener("click", () => {
    state.page = Math.max(1, state.page - 1);
    render();
  });
  $("next").addEventListener("click", () => {
    state.page += 1;
    render();
  });
  $("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    root.setAttribute("data-theme", root.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
  $("export-btn").addEventListener("click", () => note("Export is not part of this demo."));
  $("new-btn").addEventListener("click", () => note("Adding clients is not part of this demo."));

  render();
})();

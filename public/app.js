const classSelect = document.querySelector("#classSelect");
const classButtons = document.querySelector("#classButtons");
const searchInput = document.querySelector("#searchInput");
const refreshButton = document.querySelector("#refreshButton");
const updatedAt = document.querySelector("#updatedAt");
const entryCount = document.querySelector("#entryCount");
const tableBody = document.querySelector("#tableBody");
const tableTitle = document.querySelector("#tableTitle");
const tableSummary = document.querySelector("#tableSummary");
const cacheState = document.querySelector("#cacheState");
const message = document.querySelector("#message");
const disambiguationModal = document.querySelector("#disambiguationModal");
const closeDisambiguationButton = document.querySelector("#closeDisambiguationButton");
const disambiguationTitle = document.querySelector("#disambiguationTitle");
const disambiguationIntro = document.querySelector("#disambiguationIntro");
const disambiguationCandidates = document.querySelector("#disambiguationCandidates");
const disambiguationNumber = document.querySelector("#disambiguationNumber");
const saveDisambiguationButton = document.querySelector("#saveDisambiguationButton");
const disambiguationMessage = document.querySelector("#disambiguationMessage");
const manualUrlModal = document.querySelector("#manualUrlModal");
const closeManualUrlButton = document.querySelector("#closeManualUrlButton");
const manualUrlTitle = document.querySelector("#manualUrlTitle");
const manualUrlIntro = document.querySelector("#manualUrlIntro");
const manualUrlGuessed = document.querySelector("#manualUrlGuessed");
const manualUrlInput = document.querySelector("#manualUrlInput");
const saveManualUrlButton = document.querySelector("#saveManualUrlButton");
const manualUrlMessage = document.querySelector("#manualUrlMessage");

let classes = [];
let activeClass = "";
let entries = [];
let activeDisambiguationEntry = null;
let activeManualUrlEntry = null;

function formatTimestamp(value) {
  if (!value) {
    return "No cache yet";
  }

  return new Date(value).toLocaleString();
}

function setMessage(text, type = "info") {
  if (!text) {
    message.textContent = "";
    message.className = "message hidden";
    return;
  }

  message.textContent = text;
  message.className = `message ${type}`;
}

function setDisambiguationMessage(text, type = "info") {
  if (!text) {
    disambiguationMessage.textContent = "";
    disambiguationMessage.className = "message hidden";
    return;
  }

  disambiguationMessage.textContent = text;
  disambiguationMessage.className = `message ${type}`;
}

function setManualUrlMessage(text, type = "info") {
  if (!text) {
    manualUrlMessage.textContent = "";
    manualUrlMessage.className = "message hidden";
    return;
  }

  manualUrlMessage.textContent = text;
  manualUrlMessage.className = `message ${type}`;
}

function toggleDisambiguationModal(isOpen) {
  disambiguationModal.classList.toggle("hidden", !isOpen);
  disambiguationModal.setAttribute("aria-hidden", String(!isOpen));
}

function closeDisambiguationModal() {
  activeDisambiguationEntry = null;
  setDisambiguationMessage("");
  toggleDisambiguationModal(false);
}

function toggleManualUrlModal(isOpen) {
  manualUrlModal.classList.toggle("hidden", !isOpen);
  manualUrlModal.setAttribute("aria-hidden", String(!isOpen));
}

function closeManualUrlModal() {
  activeManualUrlEntry = null;
  manualUrlInput.value = "";
  manualUrlGuessed.textContent = "";
  setManualUrlMessage("");
  toggleManualUrlModal(false);
}

function renderCandidateTable(candidate) {
  const card = document.createElement("article");
  card.className = "candidate-card";

  const header = document.createElement("div");
  header.className = "candidate-header";

  const title = document.createElement("h3");
  title.textContent = candidate.title || `Candidate #${candidate.number}`;

  const meta = document.createElement("p");
  meta.className = "candidate-meta";
  meta.textContent = `Use number ${candidate.number} to match ${activeDisambiguationEntry?.name || "this lifter"}.`;

  header.append(title, meta);
  card.appendChild(header);

  if (candidate.headers?.length) {
    const wrap = document.createElement("div");
    wrap.className = "candidate-table-wrap";

    const table = document.createElement("table");
    table.className = "candidate-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const headerCell of candidate.headers) {
      const th = document.createElement("th");
      th.textContent = headerCell;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    for (const rowData of candidate.rows || []) {
      const row = document.createElement("tr");
      for (const cellData of rowData) {
        const td = document.createElement("td");
        td.textContent = cellData;
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }

    table.append(thead, tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
  }

  return card;
}

async function openDisambiguationModal(entry) {
  activeDisambiguationEntry = entry;
  disambiguationTitle.textContent = `Resolve ${entry.name}`;
  disambiguationIntro.textContent = `OpenIPF has multiple lifters under ${entry.openIpfBaseSlug}. Review the candidate page contents below, then enter the number to append to the URL.`;
  disambiguationCandidates.innerHTML = "";
  disambiguationNumber.value = entry.selectedDisambiguationNumber || "";
  setDisambiguationMessage("Loading OpenIPF candidates...");
  toggleDisambiguationModal(true);

  const params = new URLSearchParams({ name: entry.name, club: entry.club || "" });
  const response = await fetch(`/api/openipf/disambiguation?${params.toString()}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Failed to load disambiguation options.");
  }

  const payload = await response.json();
  disambiguationNumber.value = payload.selectedDisambiguationNumber || disambiguationNumber.value;
  disambiguationCandidates.innerHTML = "";

  for (const candidate of payload.candidates || []) {
    disambiguationCandidates.appendChild(renderCandidateTable(candidate));
  }

  if (!payload.candidates?.length) {
    setDisambiguationMessage("No candidates were parsed from the OpenIPF page.", "error");
    return;
  }

  setDisambiguationMessage("");
}

async function saveDisambiguationSelection() {
  if (!activeDisambiguationEntry) {
    return;
  }

  saveDisambiguationButton.disabled = true;
  setDisambiguationMessage("Saving selection...");

  const response = await fetch("/api/openipf/disambiguation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: activeDisambiguationEntry.name,
      club: activeDisambiguationEntry.club,
      disambiguationNumber: disambiguationNumber.value
    })
  });

  saveDisambiguationButton.disabled = false;

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Failed to save disambiguation selection.");
  }

  closeDisambiguationModal();
  await loadEntries(activeClass);
  setMessage("OpenIPF disambiguation saved.", "success");
}

async function openManualUrlModal(entry) {
  activeManualUrlEntry = entry;
  manualUrlTitle.textContent = `Set OpenIPF URL for ${entry.name}`;
  manualUrlIntro.textContent = "The guessed OpenIPF URL returned 404. Paste the correct lifter profile URL below to override it for this lifter.";
  manualUrlGuessed.textContent = entry.openIpfUrl || "No guessed URL";
  manualUrlInput.value = entry.manualOpenIpfUrl || "";
  setManualUrlMessage("Loading current override...");
  toggleManualUrlModal(true);

  const params = new URLSearchParams({ name: entry.name, club: entry.club || "" });
  const response = await fetch(`/api/openipf/manual-override?${params.toString()}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Failed to load OpenIPF URL override.");
  }

  const payload = await response.json();
  manualUrlGuessed.textContent = payload.guessedUrl || "No guessed URL";
  manualUrlInput.value = payload.manualOpenIpfUrl || manualUrlInput.value;
  setManualUrlMessage("");
}

async function saveManualUrlOverride() {
  if (!activeManualUrlEntry) {
    return;
  }

  saveManualUrlButton.disabled = true;
  setManualUrlMessage("Saving URL override...");

  const response = await fetch("/api/openipf/manual-override", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: activeManualUrlEntry.name,
      club: activeManualUrlEntry.club,
      openIpfUrl: manualUrlInput.value
    })
  });

  saveManualUrlButton.disabled = false;

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Failed to save manual OpenIPF URL.");
  }

  closeManualUrlModal();
  await loadEntries(activeClass);
  setMessage("OpenIPF URL override saved.", "success");
}

function filteredEntries() {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) {
    return entries;
  }

  return entries.filter((entry) => {
    return entry.name.toLowerCase().includes(query) || entry.club.toLowerCase().includes(query);
  });
}

function renderTable() {
  const visibleEntries = filteredEntries();
  tableBody.innerHTML = "";

  if (visibleEntries.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="4" class="empty">No matching entries.</td>';
    tableBody.appendChild(row);
  } else {
    for (const entry of visibleEntries) {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const clubCell = document.createElement("td");
      const bestTotalCell = document.createElement("td");
      const recentTotalCell = document.createElement("td");
      const nameStack = document.createElement("div");
      nameStack.className = "name-stack";

      if (entry.openIpfUrl && entry.profileFound && !entry.ambiguousProfile) {
        const link = document.createElement("a");
        link.href = entry.openIpfUrl;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        link.className = "athlete-link";
        link.textContent = entry.name;
        nameStack.appendChild(link);
      } else {
        const label = document.createElement("span");
        label.textContent = entry.name;
        nameStack.appendChild(label);
      }

      if (entry.canResolveAmbiguity || entry.needsManualUrl || entry.hasManualUrlOverride) {
        const controls = document.createElement("div");
        controls.className = "name-controls";

        if (entry.selectedDisambiguationNumber) {
          const badge = document.createElement("span");
          badge.className = "status-pill success";
          badge.textContent = `Matched #${entry.selectedDisambiguationNumber}`;
          controls.appendChild(badge);
        }

        if (entry.ambiguousProfile) {
          const badge = document.createElement("span");
          badge.className = "status-pill warning";
          badge.textContent = "Needs disambiguation";
          controls.appendChild(badge);
        }

        if (entry.needsManualUrl) {
          const badge = document.createElement("span");
          badge.className = "status-pill warning";
          badge.textContent = "Profile URL missing";
          controls.appendChild(badge);
        }

        if (entry.hasManualUrlOverride) {
          const badge = document.createElement("span");
          badge.className = "status-pill success";
          badge.textContent = "Manual URL set";
          controls.appendChild(badge);
        }

        if (entry.canResolveAmbiguity) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "inline-action";
          button.textContent = entry.selectedDisambiguationNumber ? "Change match" : "Resolve match";
          button.addEventListener("click", () => {
            openDisambiguationModal(entry).catch((error) => {
              setMessage(error.message, "error");
              closeDisambiguationModal();
            });
          });
          controls.appendChild(button);
        }

        if (entry.needsManualUrl || entry.hasManualUrlOverride) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "inline-action";
          button.textContent = entry.hasManualUrlOverride ? "Change URL" : "Set correct URL";
          button.addEventListener("click", () => {
            openManualUrlModal(entry).catch((error) => {
              setMessage(error.message, "error");
              closeManualUrlModal();
            });
          });
          controls.appendChild(button);
        }

        nameStack.appendChild(controls);
      }

      nameCell.appendChild(nameStack);
      clubCell.textContent = entry.club || "-";
      bestTotalCell.textContent = entry.bestTotal || "-";
      recentTotalCell.textContent = entry.lastFullPowerTotal || entry.mostRecentTotal || "-";
      row.append(nameCell, clubCell, bestTotalCell, recentTotalCell);
      tableBody.appendChild(row);
    }
  }

  entryCount.textContent = String(visibleEntries.length);
  tableTitle.textContent = activeClass ? `${activeClass} class` : "Entries";
  tableSummary.textContent = entries.length !== visibleEntries.length
    ? `${visibleEntries.length} of ${entries.length} records shown`
    : `${visibleEntries.length} records`;
}

function renderClassButtons(meta) {
  classButtons.innerHTML = "";

  for (const item of classes) {
    const count = meta?.classes?.find((metaItem) => metaItem.label === item.label)?.count || 0;
    const button = document.createElement("button");
    button.className = `pill ${item.label === activeClass ? "active" : ""}`;
    button.innerHTML = `<span>${item.label}</span><strong>${count}</strong>`;
    button.addEventListener("click", () => {
      classSelect.value = item.label;
      loadEntries(item.label);
    });
    classButtons.appendChild(button);
  }
}

async function loadClasses() {
  const response = await fetch("/api/classes");
  if (!response.ok) {
    throw new Error("Failed to load class list.");
  }

  const payload = await response.json();
  classes = payload.classes;

  classSelect.innerHTML = classes
    .map((item) => `<option value="${item.label}">${item.label}</option>`)
    .join("");

  updatedAt.textContent = formatTimestamp(payload.meta.updatedAt);
  cacheState.textContent = `${payload.meta.totalEntries} records cached`;

  if (!activeClass && classes.length > 0) {
    activeClass = classes[0].label;
    classSelect.value = activeClass;
  }

  renderClassButtons(payload.meta);
}

async function loadEntries(weightClass) {
  activeClass = weightClass;
  setMessage("Loading records...");

  const response = await fetch(`/api/entries?weightClass=${encodeURIComponent(weightClass)}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Failed to load entries.");
  }

  const payload = await response.json();
  entries = payload.entries;
  updatedAt.textContent = formatTimestamp(payload.meta.updatedAt);
  cacheState.textContent = `${payload.meta.totalEntries} records cached`;
  renderClassButtons(payload.meta);
  renderTable();
  setMessage("");
}

async function refreshCache() {
  refreshButton.disabled = true;
  setMessage("Refreshing cached records. This can take a minute.");

  const response = await fetch("/api/refresh", { method: "POST" });
  refreshButton.disabled = false;

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Refresh failed.");
  }

  await loadClasses();
  await loadEntries(activeClass || classes[0]?.label || "");
  setMessage("Records refreshed.", "success");
}

searchInput.addEventListener("input", renderTable);

classSelect.addEventListener("change", (event) => {
  loadEntries(event.target.value).catch((error) => {
    setMessage(error.message, "error");
  });
});

refreshButton.addEventListener("click", () => {
  refreshCache().catch((error) => {
    refreshButton.disabled = false;
    setMessage(error.message, "error");
  });
});

closeDisambiguationButton.addEventListener("click", closeDisambiguationModal);

disambiguationModal.addEventListener("click", (event) => {
  if (event.target === disambiguationModal) {
    closeDisambiguationModal();
  }
});

saveDisambiguationButton.addEventListener("click", () => {
  saveDisambiguationSelection().catch((error) => {
    saveDisambiguationButton.disabled = false;
    setDisambiguationMessage(error.message, "error");
  });
});

closeManualUrlButton.addEventListener("click", closeManualUrlModal);

manualUrlModal.addEventListener("click", (event) => {
  if (event.target === manualUrlModal) {
    closeManualUrlModal();
  }
});

saveManualUrlButton.addEventListener("click", () => {
  saveManualUrlOverride().catch((error) => {
    saveManualUrlButton.disabled = false;
    setManualUrlMessage(error.message, "error");
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && disambiguationModal.getAttribute("aria-hidden") === "false") {
    closeDisambiguationModal();
  }

  if (event.key === "Escape" && manualUrlModal.getAttribute("aria-hidden") === "false") {
    closeManualUrlModal();
  }
});

async function init() {
  try {
    await loadClasses();
    if (activeClass) {
      await loadEntries(activeClass);
    }
  } catch (error) {
    setMessage(error.message, "error");
  }
}

init();
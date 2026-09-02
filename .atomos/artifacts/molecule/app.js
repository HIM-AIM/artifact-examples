(() => {
  "use strict"

  const AMINO_ACIDS = {
    ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G",
    HIS: "H", ILE: "I", LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S",
    THR: "T", TRP: "W", TYR: "Y", VAL: "V", SEC: "U", PYL: "O", MSE: "M", ASX: "B",
    GLX: "Z", XLE: "J", UNK: "X"
  }

  const state = {
    viewer: null,
    source: null,
    chains: [],
    selected: new Map(),
    highlighted: new Map(),
    hiddenChains: new Set(),
    referenceID: null,
    operationsDispose: null,
    rebuilding: false,
    canvasHighlightMode: false,
    boxSelection: null,
    workspaceFiles: [],
    sequenceDragged: false,
    subscriptions: []
  }

  const els = {
    viewer: document.querySelector("#molstar-viewer"),
    empty: document.querySelector("#empty-state"),
    loading: document.querySelector("#loading"),
    title: document.querySelector("#structure-title"),
    status: document.querySelector("#status"),
    chains: document.querySelector("#chains"),
    count: document.querySelector("#selection-count"),
    clear: document.querySelector("#clear-selection"),
    addReference: document.querySelector("#add-reference"),
    chooseWorkspaceFile: document.querySelector("#choose-workspace-file"),
    openWorkspaceFile: document.querySelector("#open-workspace-file"),
    picker: document.querySelector("#workspace-picker"),
    workspaceFilter: document.querySelector("#workspace-filter"),
    workspaceFiles: document.querySelector("#workspace-files"),
    workspacePath: document.querySelector("#workspace-path"),
    refreshWorkspaceFiles: document.querySelector("#refresh-workspace-files"),
    openWorkspacePath: document.querySelector("#open-workspace-path"),
    highlightMode: document.querySelector("#canvas-highlight-mode"),
    clearCanvasHighlight: document.querySelector("#clear-canvas-highlight"),
    canvasHint: document.querySelector("#canvas-hint"),
    highlightOverlay: document.querySelector("#highlight-overlay"),
    selectionBox: document.querySelector("#selection-box"),
    chainControls: document.querySelector("#chain-controls"),
    locator: document.querySelector("#residue-locator"),
    locateChain: document.querySelector("#locate-chain"),
    locateIndex: document.querySelector("#locate-index")
  }

  function errorText(error) {
    return [error && error.message ? error.message : String(error), error && error.code, error && error.data ? JSON.stringify(error.data) : ""]
      .filter(Boolean).join(" | ")
  }

  function setStatus(message, isError = false) {
    els.status.textContent = message
    els.status.classList.toggle("error", isError)
  }

  function extensionOf(name) {
    const match = String(name).toLowerCase().match(/\.([^.]+)$/)
    return match ? match[1] : ""
  }

  function sourceFormat(name) {
    return extensionOf(name) === "pdb" ? "pdb" : "mmcif"
  }

  function residueKey(residue) {
    return `${residue.chain}\u0000${residue.seq}\u0000${residue.ins || ""}`
  }

  function schemaForResidues(residues) {
    return {
      items: residues.map((residue) => {
        const item = { auth_asym_id: residue.authChain, auth_seq_id: residue.seq }
        if (residue.ins) item.pdbx_PDB_ins_code = residue.ins
        return item
      })
    }
  }

  function schemaForChain(chain) {
    return { auth_asym_id: chain.authChain }
  }

  function tokenizeCif(text) {
    const tokens = []
    let i = 0
    let lineStart = true
    while (i < text.length) {
      const char = text[i]
      if (/\s/.test(char)) {
        lineStart = char === "\n" || (lineStart && char !== "\r")
        i += 1
        continue
      }
      if (char === "#") {
        while (i < text.length && text[i] !== "\n") i += 1
        lineStart = true
        continue
      }
      if (char === ";" && lineStart) {
        i += 1
        const start = i
        let end = text.length
        while (i < text.length) {
          if (text[i] === "\n" && text[i + 1] === ";") {
            end = i
            i += 2
            while (i < text.length && text[i] !== "\n") i += 1
            break
          }
          i += 1
        }
        tokens.push(text.slice(start, end))
        lineStart = true
        continue
      }
      if (char === "'" || char === '"') {
        const quote = char
        i += 1
        const start = i
        while (i < text.length && text[i] !== quote) i += 1
        tokens.push(text.slice(start, i))
        i += 1
        lineStart = false
        continue
      }
      const start = i
      while (i < text.length && !/\s/.test(text[i])) i += 1
      tokens.push(text.slice(start, i))
      lineStart = false
    }
    return tokens
  }

  function makeStructure(chainsMap) {
    return Array.from(chainsMap.values()).map((chain) => ({
      ...chain,
      residues: Array.from(chain.residues.values()).sort((a, b) => a.seq - b.seq || a.ins.localeCompare(b.ins))
    }))
  }

  function parsePdb(text) {
    const chains = new Map()
    for (const line of text.split(/\r?\n/)) {
      const record = line.slice(0, 6).trim()
      if (record !== "ATOM" && record !== "HETATM") continue
      const alt = line.slice(16, 17).trim()
      if (alt && alt !== "A") continue
      const name = line.slice(17, 20).trim().toUpperCase()
      if (!AMINO_ACIDS[name]) continue
      const authChain = line.slice(21, 22).trim()
      const id = authChain || "_"
      const seq = Number.parseInt(line.slice(22, 26).trim(), 10)
      if (!Number.isFinite(seq)) continue
      const ins = line.slice(26, 27).trim()
      if (!chains.has(id)) chains.set(id, { id, authChain, labelChain: authChain, residues: new Map() })
      const chain = chains.get(id)
      const key = `${seq}:${ins}`
      if (!chain.residues.has(key)) chain.residues.set(key, { chain: id, authChain, labelChain: authChain, seq, ins, name, one: AMINO_ACIDS[name] })
    }
    return makeStructure(chains)
  }

  function parseMmcif(text) {
    const tokens = tokenizeCif(text)
    const chains = new Map()
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].toLowerCase() !== "loop_") continue
      const headers = []
      let cursor = i + 1
      while (cursor < tokens.length && tokens[cursor].startsWith("_")) headers.push(tokens[cursor++].toLowerCase())
      if (!headers.some((header) => header.startsWith("_atom_site."))) continue
      const index = (names) => names.map((name) => headers.indexOf(`_atom_site.${name}`)).find((value) => value >= 0) ?? -1
      const groupIndex = index(["group_pdb"])
      const authChainIndex = index(["auth_asym_id", "label_asym_id"])
      const labelChainIndex = index(["label_asym_id", "auth_asym_id"])
      const seqIndex = index(["auth_seq_id", "label_seq_id"])
      const nameIndex = index(["auth_comp_id", "label_comp_id"])
      const insIndex = index(["pdbx_pdb_ins_code"])
      if (authChainIndex < 0 || seqIndex < 0 || nameIndex < 0) continue
      while (cursor + headers.length <= tokens.length) {
        const first = tokens[cursor]
        if (first === "loop_" || first === "stop_" || first.startsWith("_") || first.startsWith("data_") || first.startsWith("save_")) break
        const row = tokens.slice(cursor, cursor + headers.length)
        cursor += headers.length
        if (groupIndex >= 0 && !["ATOM", "HETATM"].includes(row[groupIndex].toUpperCase())) continue
        const name = row[nameIndex].toUpperCase()
        if (!AMINO_ACIDS[name]) continue
        const seq = Number.parseInt(row[seqIndex], 10)
        if (!Number.isFinite(seq)) continue
        const clean = (value, fallback = "_") => !value || value === "." || value === "?" ? fallback : value
        const authChain = clean(row[authChainIndex])
        const labelChain = clean(row[labelChainIndex], authChain)
        const id = authChain
        const ins = clean(insIndex >= 0 ? row[insIndex] : "", "")
        if (!chains.has(id)) chains.set(id, { id, authChain, labelChain, residues: new Map() })
        const chain = chains.get(id)
        const key = `${seq}:${ins}`
        if (!chain.residues.has(key)) chain.residues.set(key, { chain: id, authChain, labelChain, seq, ins, name, one: AMINO_ACIDS[name] })
      }
      i = cursor - 1
    }
    return makeStructure(chains)
  }

  function parseStructure(text, name) {
    return sourceFormat(name) === "pdb" ? parsePdb(text) : parseMmcif(text)
  }

  function getChain(chainID) {
    const chain = state.chains.find((item) => item.id === chainID || item.authChain === chainID || item.labelChain === chainID)
    if (!chain) throw new Error(`Unknown chain '${chainID}'. Available chains: ${state.chains.map((item) => item.id).join(", ")}`)
    return chain
  }

  function resolveResidues(items) {
    return items.map((item) => {
      const chain = getChain(item.chain)
      const residue = chain.residues.find((candidate) => candidate.seq === item.seq && (!item.ins || candidate.ins === item.ins))
      if (!residue) throw new Error(`Residue ${item.chain}:${item.seq}${item.ins || ""} was not found.`)
      return residue
    })
  }

  function applySelection() {
    if (!state.viewer) return
    const residues = Array.from(state.selected.values())
    state.viewer.structureInteractivity({ action: "select" })
    if (residues.length) state.viewer.structureInteractivity({ elements: schemaForResidues(residues), action: "select", applyGranularity: false })
  }

  function modifySchemaSelection(schema, modifier = "add") {
    if (!state.viewer) return
    const manager = state.viewer.plugin.managers.structure.selection
    if (modifier === "set") {
      state.viewer.structureInteractivity({ elements: schema, action: "select", applyGranularity: false })
      return
    }
    const snapshot = manager.getSnapshot()
    state.viewer.structureInteractivity({ elements: schema, action: "select", applyGranularity: false })
    const locis = []
    for (const structure of state.viewer.plugin.managers.structure.hierarchy.current.structures) {
      const data = structure.cell && structure.cell.obj && structure.cell.obj.data
      if (!data) continue
      const loci = manager.getLoci(data)
      if (loci && loci.kind !== "empty-loci") locis.push(loci)
    }
    manager.setSnapshot(snapshot)
    for (const loci of locis) manager.fromLoci(modifier, loci, false)
  }

  function applyHighlight(residuesOrChain, modifier = "add") {
    if (!state.viewer || !residuesOrChain) return
    if (Array.isArray(residuesOrChain)) {
      for (const residue of residuesOrChain) state.highlighted.set(residueKey(residue), residue)
      modifySchemaSelection(schemaForResidues(residuesOrChain), modifier)
    } else {
      state.highlighted.set(`chain:${residuesOrChain.id}`, { chainOnly: residuesOrChain.id })
      modifySchemaSelection(schemaForChain(residuesOrChain), modifier)
    }
    updateSelectionUI()
  }

  async function applyHiddenChains() {
    const manager = state.viewer.plugin.managers.structure.selection
    const snapshot = manager.getSnapshot()
    for (const chainID of state.hiddenChains) {
      const chain = getChain(chainID)
      state.viewer.structureInteractivity({ action: "select" })
      state.viewer.structureInteractivity({ elements: schemaForChain(chain), action: "select", applyGranularity: false })
      const structures = state.viewer.plugin.managers.structure.hierarchy.current.structures
      const components = structures.flatMap((structure) => structure.components)
      await state.viewer.plugin.managers.structure.component.modifyByCurrentSelection(components, "subtract")
    }
    manager.setSnapshot(snapshot)
  }

  async function rebuildScene() {
    if (!state.source || state.rebuilding) return
    state.rebuilding = true
    els.loading.hidden = false
    try {
      await state.viewer.plugin.clear()
      await state.viewer.loadStructureFromData(state.source.text, state.source.format, { dataLabel: state.source.name })
      await applyHiddenChains()
      applySelection()
      if (state.highlighted.size) {
        const markers = Array.from(state.highlighted.values())
        for (const marker of markers) applyHighlight(marker.chainOnly ? getChain(marker.chainOnly) : [marker])
      }
    } finally {
      state.rebuilding = false
      els.loading.hidden = true
    }
  }

  function updateSelectionUI() {
    const stats = state.viewer && state.viewer.plugin.managers.structure.selection.stats
    const canvasCount = stats && stats.elementCount ? stats.elementCount : 0
    const count = state.selected.size
    els.count.textContent = canvasCount ? stats.label : `${count} residue${count === 1 ? "" : "s"} selected`
    els.clear.disabled = count === 0 && canvasCount === 0 && state.highlighted.size === 0
    els.clearCanvasHighlight.disabled = els.clear.disabled
    els.addReference.disabled = count === 0 && canvasCount === 0
    document.querySelectorAll(".residue").forEach((button) => button.classList.toggle("selected", state.selected.has(button.dataset.key)))
  }

  function orderedSetValues(set) {
    if (typeof set !== "number") return Array.from(set)
    const buffer = new ArrayBuffer(8)
    new Float64Array(buffer)[0] = set
    const bounds = new Int32Array(buffer)
    const values = []
    for (let i = bounds[0]; i < bounds[1]; i += 1) values.push(i)
    return values
  }

  function getHighlightedResidues() {
    if (!state.viewer) return []
    const residues = new Map()
    for (const entry of state.viewer.plugin.managers.structure.selection.entries.values()) {
      const loci = entry.selection
      if (!loci || loci.kind !== "element-loci") continue
      for (const element of loci.elements) {
        const unit = element.unit
        const hierarchy = unit.model && unit.model.atomicHierarchy
        if (!hierarchy) continue
        for (const unitIndex of orderedSetValues(element.indices)) {
          const atomIndex = unit.elements[unitIndex]
          const residueIndex = hierarchy.residueAtomSegments.index[atomIndex]
          const chainIndex = hierarchy.chainAtomSegments.index[atomIndex]
          const chain = hierarchy.chains.auth_asym_id.value(chainIndex) || hierarchy.chains.label_asym_id.value(chainIndex)
          const seq = hierarchy.residues.auth_seq_id.value(residueIndex)
          const ins = hierarchy.residues.pdbx_PDB_ins_code.value(residueIndex) || ""
          const name = hierarchy.atoms.auth_comp_id.value(atomIndex) || hierarchy.atoms.label_comp_id.value(atomIndex)
          const key = `${chain}\u0000${seq}\u0000${ins}`
          if (!residues.has(key)) residues.set(key, { chain, seq, ins, name })
        }
      }
    }
    return Array.from(residues.values()).sort((a, b) => a.chain.localeCompare(b.chain) || a.seq - b.seq || a.ins.localeCompare(b.ins))
  }

  function renderChains() {
    els.chains.replaceChildren()
    els.chainControls.replaceChildren()
    els.locateChain.replaceChildren()
    for (const chain of state.chains) {
      const controls = document.createElement("div")
      controls.className = `chain-control${state.hiddenChains.has(chain.id) ? " hidden-chain" : ""}`
      const badge = document.createElement("span")
      badge.className = "chain-badge"
      badge.textContent = `${chain.id} · ${chain.residues.length}`
      const highlight = document.createElement("button")
      highlight.className = "mini-button"
      highlight.type = "button"
      highlight.textContent = "Highlight"
      highlight.addEventListener("click", () => {
        applyHighlight(chain)
        setStatus(`Highlighted chain ${chain.id}.`)
      })
      const visibility = document.createElement("button")
      visibility.className = `mini-button${state.hiddenChains.has(chain.id) ? " active" : ""}`
      visibility.type = "button"
      visibility.textContent = state.hiddenChains.has(chain.id) ? "Show" : "Hide"
      visibility.addEventListener("click", async () => {
        if (state.hiddenChains.has(chain.id)) state.hiddenChains.delete(chain.id)
        else state.hiddenChains.add(chain.id)
        renderChains()
        await rebuildScene()
        setStatus(`${state.hiddenChains.has(chain.id) ? "Hidden" : "Shown"} chain ${chain.id}.`)
      })
      controls.append(badge, highlight, visibility)
      els.chainControls.append(controls)

      const option = document.createElement("option")
      option.value = chain.id
      option.textContent = chain.id
      els.locateChain.append(option)

      const row = document.createElement("div")
      row.className = `sequence-row${state.hiddenChains.has(chain.id) ? " hidden-chain" : ""}`
      const chainLabel = document.createElement("span")
      chainLabel.className = "sequence-chain-label"
      chainLabel.textContent = chain.id
      const scroll = document.createElement("div")
      scroll.className = "sequence-scroll"
      const track = document.createElement("div")
      track.className = "sequence-track"
      for (const residue of chain.residues) {
        const button = document.createElement("button")
        button.type = "button"
        button.className = "residue"
        button.dataset.key = residueKey(residue)
        button.title = `${residue.name} · chain ${chain.id} · residue ${residue.seq}${residue.ins}`
        const letter = document.createElement("span")
        letter.className = "residue-letter"
        letter.textContent = residue.one
        const number = document.createElement("span")
        number.className = "residue-number"
        number.textContent = `${residue.seq}${residue.ins}`
        button.append(letter, number)
        button.addEventListener("click", (event) => {
          if (state.sequenceDragged) {
            event.preventDefault()
            return
          }
          const key = residueKey(residue)
          if (state.selected.has(key)) {
            state.selected.delete(key)
            state.highlighted.delete(key)
            modifySchemaSelection(schemaForResidues([residue]), "remove")
          } else {
            state.selected.set(key, residue)
            applyHighlight([residue], "add")
          }
          updateSelectionUI()
          setStatus(`${state.selected.size} residue${state.selected.size === 1 ? "" : "s"} selected.`)
        })
        track.append(button)
      }
      scroll.append(track)
      row.append(chainLabel, scroll)
      els.chains.append(row)
    }
    updateSelectionUI()
  }

  function clearAllHighlights() {
    state.selected.clear()
    state.highlighted.clear()
    if (state.viewer) {
      state.viewer.structureInteractivity({ action: ["select", "highlight"] })
      state.viewer.plugin.managers.structure.selection.clear()
    }
    updateSelectionUI()
    setStatus("All residue highlights were cleared.")
  }

  function setCanvasHighlightMode(enabled) {
    state.canvasHighlightMode = enabled && Boolean(state.source)
    els.highlightOverlay.classList.toggle("active", state.canvasHighlightMode)
    els.highlightMode.classList.toggle("active", state.canvasHighlightMode)
    els.highlightMode.textContent = state.canvasHighlightMode ? "Highlight mode on" : "Highlight residues"
    els.canvasHint.textContent = state.canvasHighlightMode
      ? "Left: add highlight · Right: remove · Drag: box select"
      : state.source ? "Turn on highlight mode to pick residues" : "Load a structure to enable picking"
  }

  function updateSelectionBox() {
    const box = state.boxSelection
    if (!box) {
      els.selectionBox.hidden = true
      els.highlightOverlay.classList.remove("remove")
      return
    }
    const left = Math.min(box.x0, box.x1)
    const top = Math.min(box.y0, box.y1)
    els.highlightOverlay.classList.toggle("remove", box.button === 2)
    els.selectionBox.hidden = false
    els.selectionBox.style.left = `${left}px`
    els.selectionBox.style.top = `${top}px`
    els.selectionBox.style.width = `${Math.abs(box.x1 - box.x0)}px`
    els.selectionBox.style.height = `${Math.abs(box.y1 - box.y0)}px`
  }

  function modifyPickedAt(x, y, modifier) {
    if (!state.viewer) return false
    const picking = state.viewer.plugin.canvas3d.identify([x, y])
    if (!picking) return false
    const current = state.viewer.plugin.canvas3d.getLoci(picking.id)
    if (!current || !current.loci) return false
    state.viewer.plugin.managers.structure.selection.fromLoci(modifier, current.loci, true)
    return true
  }

  function finishBoxSelection() {
    const box = state.boxSelection
    state.boxSelection = null
    updateSelectionBox()
    if (!box || !state.viewer) return
    const modifier = box.button === 2 ? "remove" : "add"
    if (!box.moved) {
      if (modifyPickedAt(box.x1, box.y1, modifier)) {
        state.selected.clear()
        state.highlighted.clear()
        updateSelectionUI()
        setStatus(`${modifier === "add" ? "Added" : "Removed"} residue highlight.`)
      }
      return
    }
    const left = Math.min(box.x0, box.x1)
    const right = Math.max(box.x0, box.x1)
    const top = Math.min(box.y0, box.y1)
    const bottom = Math.max(box.y0, box.y1)
    const step = Math.max(6, Math.ceil((right - left) / 36), Math.ceil((bottom - top) / 26))
    let changed = false
    for (let y = top; y <= bottom; y += step) {
      for (let x = left; x <= right; x += step) {
        changed = modifyPickedAt(x, y, modifier) || changed
      }
    }
    if (changed) {
      state.selected.clear()
      state.highlighted.clear()
    }
    updateSelectionUI()
    const stats = state.viewer.plugin.managers.structure.selection.stats
    setStatus(`Box highlight ${modifier === "add" ? "added" : "removed"}: ${stats.label || "no residues highlighted"}.`)
  }

  function locateResidue(chainID, seq) {
    const chain = getChain(chainID)
    const residue = chain.residues.find((item) => item.seq === seq)
    if (!residue) throw new Error(`Residue ${chainID}:${seq} was not found.`)
    const button = Array.from(document.querySelectorAll(".residue")).find((item) => item.dataset.key === residueKey(residue))
    if (button) {
      button.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
      button.classList.add("located")
      window.setTimeout(() => button.classList.remove("located"), 1600)
    }
    applyHighlight([residue])
    state.viewer.structureInteractivity({ elements: schemaForResidues([residue]), action: "focus", applyGranularity: false })
    setStatus(`Located chain ${chain.id}, ${residue.name} ${residue.seq}${residue.ins}.`)
  }

  function renderWorkspaceFiles() {
    const query = els.workspaceFilter.value.trim().toLowerCase()
    const files = state.workspaceFiles.filter((path) => path.toLowerCase().includes(query))
    els.workspaceFiles.replaceChildren()
    if (!files.length) {
      const empty = document.createElement("div")
      empty.className = "workspace-empty"
      empty.textContent = state.workspaceFiles.length ? "No matching structure files." : "No structure files found in this Workspace."
      els.workspaceFiles.append(empty)
      return
    }
    for (const path of files) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "workspace-file"
      button.textContent = path
      button.addEventListener("click", () => openWorkspacePath(path))
      els.workspaceFiles.append(button)
    }
  }

  async function scanWorkspaceFiles() {
    els.workspaceFiles.innerHTML = '<div class="workspace-empty">Scanning Workspace...</div>'
    const files = []
    const skipped = new Set([".git", "node_modules", "vendor", "dist", "build", ".cache"])
    async function visit(path, depth) {
      if (depth > 10 || files.length >= 5000) return
      let nodes
      try { nodes = await window.atomos.workspace.list(path) }
      catch (_) { return }
      for (const node of nodes) {
        if (node.type === "file" && ["pdb", "cif", "mmcif"].includes(extensionOf(node.name))) files.push(node.path)
        if (node.type === "directory" && !skipped.has(node.name)) await visit(node.path, depth + 1)
      }
    }
    await visit("", 0)
    state.workspaceFiles = files.sort((a, b) => a.localeCompare(b))
    renderWorkspaceFiles()
  }

  async function showWorkspacePicker() {
    els.picker.showModal()
    if (!state.workspaceFiles.length) await scanWorkspaceFiles()
  }

  async function openWorkspacePath(path) {
    const cleanPath = String(path || "").trim().replace(/^\/+/, "")
    if (!cleanPath) return
    els.loading.hidden = false
    try {
      await loadSource(await readWorkspaceText(cleanPath), cleanPath.split("/").pop(), cleanPath)
      els.picker.close()
    } catch (error) {
      setStatus(errorText(error), true)
    } finally {
      els.loading.hidden = true
    }
  }

  function selectionReferenceText() {
    const residues = getHighlightedResidues()
    const lines = [`Structure: ${state.source.name}`, `Highlighted residues (${residues.length}):`]
    for (const residue of residues) lines.push(`- Chain ${residue.chain}, ${residue.name} ${residue.seq}${residue.ins}`)
    return lines.join("\n")
  }

  async function addSelectionToConversation() {
    const canvasStats = state.viewer.plugin.managers.structure.selection.stats
    if (!state.selected.size && !canvasStats.elementCount) throw new Error("Select at least one residue first.")
    const countLabel = state.selected.size || canvasStats.label
    state.referenceID = await window.atomos.conversation.addReference({
      idempotencyKey: crypto.randomUUID(),
      label: `${state.source.name}: ${countLabel} selected`,
      text: selectionReferenceText(),
      location: state.source.path || state.source.name
    })
    setStatus("Selected residues were added to the conversation.")
    return { added: state.selected.size, referenceID: state.referenceID }
  }

  function operationSchemas() {
    const chainInput = {
      type: "object",
      properties: { chain: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["chain"],
      additionalProperties: false
    }
    const residuesInput = {
      type: "object",
      properties: {
        residues: {
          type: "array", minItems: 1, maxItems: 500,
          items: {
            type: "object",
            properties: {
              chain: { type: "string", minLength: 1, maxLength: 64 },
              seq: { type: "integer", minimum: -1000000, maximum: 1000000 },
              ins: { type: "string", maxLength: 8 }
            },
            required: ["chain", "seq"],
            additionalProperties: false
          }
        },
        mode: { type: "string", enum: ["replace", "add"], maxLength: 7 }
      },
      required: ["residues"],
      additionalProperties: false
    }
    return { chainInput, residuesInput }
  }

  function exposeOperations() {
    if (state.operationsDispose) state.operationsDispose()
    const { chainInput, residuesInput } = operationSchemas()
    state.operationsDispose = window.atomos.artifact.exposeOperations({
      get_structure_summary: {
        description: "List the loaded structure, chains, amino-acid counts, hidden chains, and selected residues.",
        run: () => ({
          file: state.source.name,
          chains: state.chains.map((chain) => ({ id: chain.id, residueCount: chain.residues.length, sequence: chain.residues.map((residue) => residue.one).join("") })),
          hiddenChains: Array.from(state.hiddenChains),
          highlightedResidues: getHighlightedResidues()
        })
      },
      get_highlighted_residues: {
        description: "Return every currently highlighted residue with chain, author residue index, insertion code, and residue name.",
        run: () => ({ residues: getHighlightedResidues() })
      },
      highlight_residues: {
        description: "Highlight one or more residues by chain and author residue number.",
        inputSchema: residuesInput,
        run: ({ residues }) => {
          const resolved = resolveResidues(residues)
          applyHighlight(resolved)
          setStatus(`Agent highlighted ${resolved.length} residue${resolved.length === 1 ? "" : "s"}.`)
          return { highlighted: resolved.length }
        }
      },
      select_residues: {
        description: "Select residues so they can be added to the conversation. Mode defaults to replace.",
        inputSchema: residuesInput,
        run: ({ residues, mode = "replace" }) => {
          const resolved = resolveResidues(residues)
          if (mode === "replace") clearAllHighlights()
          for (const residue of resolved) state.selected.set(residueKey(residue), residue)
          applyHighlight(resolved, "add")
          updateSelectionUI()
          setStatus(`Agent selected ${state.selected.size} residue${state.selected.size === 1 ? "" : "s"}.`)
          return { selected: state.selected.size }
        }
      },
      clear_selection: {
        description: "Clear all selected residues.",
        run: () => {
          clearAllHighlights()
          return { selected: 0 }
        }
      },
      highlight_chain: {
        description: "Highlight an entire chain.",
        inputSchema: chainInput,
        run: ({ chain }) => {
          const resolved = getChain(chain)
          applyHighlight(resolved)
          setStatus(`Agent highlighted chain ${resolved.id}.`)
          return { highlightedChain: resolved.id }
        }
      },
      clear_highlight: {
        description: "Clear the current molecular highlight.",
        run: () => {
          clearAllHighlights()
          return { highlighted: 0 }
        }
      },
      hide_chain: {
        description: "Hide a chain from the Mol* scene.",
        inputSchema: chainInput,
        run: async ({ chain }) => {
          const resolved = getChain(chain)
          state.hiddenChains.add(resolved.id)
          renderChains()
          await rebuildScene()
          setStatus(`Agent hid chain ${resolved.id}.`)
          return { hiddenChain: resolved.id }
        }
      },
      show_chain: {
        description: "Show a previously hidden chain.",
        inputSchema: chainInput,
        run: async ({ chain }) => {
          const resolved = getChain(chain)
          state.hiddenChains.delete(resolved.id)
          renderChains()
          await rebuildScene()
          setStatus(`Agent showed chain ${resolved.id}.`)
          return { shownChain: resolved.id }
        }
      },
      show_all_chains: {
        description: "Show every chain in the Mol* scene.",
        run: async () => {
          state.hiddenChains.clear()
          renderChains()
          await rebuildScene()
          setStatus("All chains are visible.")
          return { hiddenChains: 0 }
        }
      },
      add_selection_to_conversation: {
        description: "Add the currently selected residues to the conversation as an explicit Artifact reference.",
        run: addSelectionToConversation
      }
    })
  }

  async function loadSource(text, name, path) {
    const ext = extensionOf(name)
    if (!["pdb", "cif", "mmcif"].includes(ext)) throw new Error("Unsupported structure format. Use .pdb, .cif, or .mmcif.")
    const chains = parseStructure(text, name)
    if (!chains.length) throw new Error("No amino-acid chains were found in this structure.")
    state.source = { text, name, path, format: sourceFormat(name) }
    state.chains = chains
    state.selected.clear()
    state.hiddenChains.clear()
    state.highlighted.clear()
    setCanvasHighlightMode(false)
    els.empty.hidden = true
    els.title.textContent = name
    els.highlightMode.disabled = false
    els.clearCanvasHighlight.disabled = false
    renderChains()
    await rebuildScene()
    await window.atomos.artifact.setTitle(`Molecule · ${name}`)
    if (path) {
      try { await window.atomos.artifact.save("recent-source.json", { path }) }
      catch (error) { console.warn("Could not persist recent Molecule source", error) }
    }
    exposeOperations()
    const residueCount = chains.reduce((sum, chain) => sum + chain.residues.length, 0)
    setStatus(`Loaded ${chains.length} chain${chains.length === 1 ? "" : "s"} and ${residueCount} amino acids.`)
  }

  async function readWorkspaceText(path) {
    const decoder = new TextDecoder()
    const parts = []
    const chunkSize = 10 * 1024 * 1024
    let offset = 0
    while (true) {
      const chunk = await window.atomos.workspace.readRange(path, { offset, length: chunkSize })
      parts.push(decoder.decode(chunk.content, { stream: !chunk.eof }))
      offset += chunk.content.length
      if (chunk.eof) break
      if (offset >= 100 * 1024 * 1024) throw new Error("Structure files larger than 100 MiB are not supported.")
    }
    return parts.join("")
  }

  async function initialize() {
    try {
      state.viewer = await molstar.Viewer.create(els.viewer, {
        layoutIsExpanded: false,
        layoutShowControls: false,
        layoutShowSequence: false,
        layoutShowLog: false,
        layoutShowLeftPanel: false,
        collapseLeftPanel: true,
        viewportShowExpand: false,
        viewportShowSelectionMode: false,
        viewportShowAnimation: true,
        viewportBackgroundColor: "#090d12"
      })
      state.viewer.plugin.managers.interactivity.setProps({ granularity: "residue" })
      state.viewer.plugin.canvas3d.setProps({
        renderer: { selectColor: 0x59e0cf, highlightColor: 0xffcb6b, selectStrength: 0.72 },
        marking: { enabled: true }
      })
      state.subscriptions.push(
        state.viewer.plugin.managers.structure.selection.events.changed.subscribe(updateSelectionUI)
      )

      const inputs = await window.atomos.artifact.getOpenInputs()
      let path = inputs && inputs.structure && inputs.structure.path
      if (!path) {
        try {
          const recent = await window.atomos.artifact.load("recent-source.json")
          if (recent && typeof recent.path === "string") path = recent.path
        } catch (error) {
          console.warn("Could not restore recent Molecule source", error)
        }
      }
      if (path) {
        els.loading.hidden = false
        await loadSource(await readWorkspaceText(path), path.split("/").pop(), path)
        els.loading.hidden = true
      }
    } catch (error) {
      els.loading.hidden = true
      setStatus(errorText(error), true)
    }
  }

  els.chooseWorkspaceFile.addEventListener("click", showWorkspacePicker)
  els.openWorkspaceFile.addEventListener("click", showWorkspacePicker)
  els.refreshWorkspaceFiles.addEventListener("click", scanWorkspaceFiles)
  els.workspaceFilter.addEventListener("input", renderWorkspaceFiles)
  els.openWorkspacePath.addEventListener("click", () => openWorkspacePath(els.workspacePath.value))
  els.workspacePath.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      openWorkspacePath(els.workspacePath.value)
    }
  })
  els.highlightMode.addEventListener("click", () => setCanvasHighlightMode(!state.canvasHighlightMode))
  els.highlightOverlay.addEventListener("contextmenu", (event) => event.preventDefault())
  els.highlightOverlay.addEventListener("pointerdown", (event) => {
    if (!state.canvasHighlightMode || ![0, 2].includes(event.button)) return
    event.preventDefault()
    const rect = els.highlightOverlay.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    state.boxSelection = { button: event.button, x0: x, y0: y, x1: x, y1: y, moved: false }
    els.highlightOverlay.setPointerCapture(event.pointerId)
  })
  els.highlightOverlay.addEventListener("pointermove", (event) => {
    const box = state.boxSelection
    if (!box) return
    const rect = els.highlightOverlay.getBoundingClientRect()
    box.x1 = event.clientX - rect.left
    box.y1 = event.clientY - rect.top
    box.moved = box.moved || Math.abs(box.x1 - box.x0) > 4 || Math.abs(box.y1 - box.y0) > 4
    if (box.moved) updateSelectionBox()
  })
  els.highlightOverlay.addEventListener("pointerup", (event) => {
    if (!state.boxSelection) return
    event.preventDefault()
    const rect = els.highlightOverlay.getBoundingClientRect()
    state.boxSelection.x1 = event.clientX - rect.left
    state.boxSelection.y1 = event.clientY - rect.top
    finishBoxSelection()
  })
  els.highlightOverlay.addEventListener("pointercancel", () => {
    state.boxSelection = null
    updateSelectionBox()
  })
  els.clearCanvasHighlight.addEventListener("click", clearAllHighlights)
  els.clear.addEventListener("click", clearAllHighlights)
  els.locator.addEventListener("submit", (event) => {
    event.preventDefault()
    try { locateResidue(els.locateChain.value, Number.parseInt(els.locateIndex.value, 10)) }
    catch (error) { setStatus(errorText(error), true) }
  })

  let sequenceDrag
  els.chains.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return
    const scroll = event.target.closest(".sequence-scroll")
    if (!scroll) return
    sequenceDrag = { x: event.clientX, scrollLeft: scroll.scrollLeft, moved: false, scroll }
    state.sequenceDragged = false
    scroll.setPointerCapture(event.pointerId)
  })
  els.chains.addEventListener("pointermove", (event) => {
    if (!sequenceDrag) return
    const delta = event.clientX - sequenceDrag.x
    if (Math.abs(delta) > 4) {
      sequenceDrag.moved = true
      state.sequenceDragged = true
      sequenceDrag.scroll.classList.add("dragging")
      sequenceDrag.scroll.scrollLeft = sequenceDrag.scrollLeft - delta
    }
  })
  const endSequenceDrag = () => {
    if (!sequenceDrag) return
    const moved = sequenceDrag.moved
    sequenceDrag.scroll.classList.remove("dragging")
    sequenceDrag = null
    window.setTimeout(() => { state.sequenceDragged = false }, moved ? 50 : 0)
  }
  els.chains.addEventListener("pointerup", endSequenceDrag)
  els.chains.addEventListener("pointercancel", endSequenceDrag)
  els.addReference.addEventListener("click", async () => {
    try { await addSelectionToConversation() }
    catch (error) { setStatus(errorText(error), true) }
  })
  window.addEventListener("beforeunload", () => {
    if (state.operationsDispose) state.operationsDispose()
    for (const subscription of state.subscriptions) subscription.unsubscribe()
    if (state.viewer) state.viewer.dispose()
  })

  initialize()
})()

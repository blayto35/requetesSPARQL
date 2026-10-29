import axios from "axios";

interface Binding {
	type: string;
	value: string;
}

interface SparqlRow {
	entity: Binding;
	label: Binding;
}

interface SparqlResponse {
	results: {
		bindings: SparqlRow[];
	};
}

interface MoleculeResult {
	label: string;
	id: string;
}

const endpoint = "http://localhost:7020";
const form = document.querySelector<HTMLFormElement>("#search-form");
const input = document.querySelector<HTMLInputElement>("#requete");
const suggestions = document.querySelector<HTMLDivElement>("#molecule-suggestions");
const resultsContainer = document.querySelector<HTMLElement>("#results");

if (!form || !input || !suggestions || !resultsContainer) {
	throw new Error("Le formulaire de recherche est introuvable.");
}

const resultPanel: HTMLElement = resultsContainer;
const searchInput: HTMLInputElement = input;
const suggestionList: HTMLDivElement = suggestions;
let suggestionTimer: ReturnType<typeof setTimeout> | undefined;
let suggestionRequestId = 0;
let activeSuggestionIndex = -1;

function escapeSparqlLiteral(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

function chebiIdFromUri(uri: string): string | null {
	return uri.match(/CHEBI[_:](\d+)/i)?.[1] ?? null;
}

function getSearchTerms(searchTerm: string): { label: string; identifier: string | undefined } {
	const normalizedTerm = searchTerm.trim();
	const label = normalizedTerm
		.replace(/\s*\(\s*CHEBI\s*[:_]\s*\d+\s*\)\s*$/i, "")
	const identifier = normalizedTerm.match(/CHEBI\s*[:_]\s*(\d+)/i)?.[1]
		?? normalizedTerm.match(/^\s*(\d+)\s*$/)?.[1];
	return { label, identifier };
}

function buildExactQuery(searchTerm: string): string {
	const { label, identifier } = getSearchTerms(searchTerm);
	const filter = identifier
		? `STR(?entity) = "http://purl.obolibrary.org/obo/CHEBI_${identifier}"`
		: `LCASE(STR(?label)) = "${escapeSparqlLiteral(label.toLowerCase())}"`;

	return `
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?entity ?label WHERE {
  ?entity rdfs:label ?label .
  FILTER (${filter})
}
LIMIT 100`;
}

function buildDescendantsQuery(rootIds: string[]): string {
	const roots = rootIds
		.map((id) => `<http://purl.obolibrary.org/obo/CHEBI_${id}>`)
		.join(" ");

	return `
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?entity ?label WHERE {
  VALUES ?root { ${roots} }
  ?entity rdfs:subClassOf+ ?root .
  ?entity rdfs:label ?label .
}
LIMIT 1000`;
}

function buildPartialQuery(searchTerm: string): string {
	const { label, identifier } = getSearchTerms(searchTerm);
	const escapedTerm = escapeSparqlLiteral(label.toLowerCase());
	const chebiUri = identifier
		? `|| STR(?entity) = "http://purl.obolibrary.org/obo/CHEBI_${identifier}"`
		: "";

	return `
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?entity ?label WHERE {
  ?entity rdfs:label ?label .
  FILTER (CONTAINS(LCASE(STR(?label)), "${escapedTerm}") ${chebiUri})
}
LIMIT 50`;
}

function buildSuggestionQuery(searchTerm: string): string {
	const normalizedTerm = searchTerm.trim().toLowerCase();
	const partialId = normalizedTerm.match(/^(?:chebi\s*[:_]\s*)?(\d+)$/)?.[1];
	const filter = partialId
		? `CONTAINS(STR(?entity), "CHEBI_${escapeSparqlLiteral(partialId)}")`
		: `CONTAINS(LCASE(STR(?label)), "${escapeSparqlLiteral(normalizedTerm)}")`;
	const labelPrefix = partialId ? "" : `DESC(STRSTARTS(LCASE(STR(?label)), "${escapeSparqlLiteral(normalizedTerm)}"))`;
	const order = [labelPrefix, "ASC(STRLEN(STR(?label)))", "LCASE(STR(?label))"].filter(Boolean).join(" ");

	return `
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?entity ?label WHERE {
  ?entity rdfs:label ?label .
  FILTER (${filter})
}
ORDER BY ${order}
LIMIT 50`;
}

function getMolecules(rows: SparqlRow[]): MoleculeResult[] {
	const molecules = new Map<string, MoleculeResult>();

	for (const row of rows) {
		const id = chebiIdFromUri(row.entity.value);
		if (!id) continue;
		if (!molecules.has(row.entity.value)) {
			molecules.set(row.entity.value, { label: row.label.value, id });
		}
	}

	return [...molecules.values()];
}

function closeSuggestions(): void {
	suggestionList.hidden = true;
	suggestionList.replaceChildren();
	searchInput.setAttribute("aria-expanded", "false");
	searchInput.removeAttribute("aria-activedescendant");
	activeSuggestionIndex = -1;
}

function setActiveSuggestion(index: number): void {
	const options = Array.from(suggestionList.querySelectorAll<HTMLElement>("[role='option']"));
	if (options.length === 0) return;
	activeSuggestionIndex = (index + options.length) % options.length;
	options.forEach((option, optionIndex) => {
		const isActive = optionIndex === activeSuggestionIndex;
		option.setAttribute("aria-selected", String(isActive));
		option.classList.toggle("is-active", isActive);
	});
	searchInput.setAttribute("aria-activedescendant", options[activeSuggestionIndex].id);
}

function chooseSuggestion(molecule: MoleculeResult): void {
	searchInput.value = `${molecule.label} (CHEBI:${molecule.id})`;
	closeSuggestions();
	searchInput.focus();
}

input.addEventListener("keydown", (event) => {
	const options = suggestionList.querySelectorAll<HTMLElement>("[role='option']");
	if (event.key === "ArrowDown" && options.length > 0) {
		event.preventDefault();
		setActiveSuggestion(activeSuggestionIndex + 1);
	} else if (event.key === "ArrowUp" && options.length > 0) {
		event.preventDefault();
		setActiveSuggestion(activeSuggestionIndex < 0 ? options.length - 1 : activeSuggestionIndex - 1);
	} else if (event.key === "Enter" && activeSuggestionIndex >= 0) {
		event.preventDefault();
		const option = options[activeSuggestionIndex];
		if (option) option.click();
	} else if (event.key === "Escape") {
		closeSuggestions();
	}
});

suggestions.addEventListener("pointerdown", (event) => event.preventDefault());

input.addEventListener("input", () => {
	if (suggestionTimer) clearTimeout(suggestionTimer);
	closeSuggestions();
	const searchTerm = input.value.trim();
	const requestId = ++suggestionRequestId;
	if (searchTerm.length < 2) return;

	suggestionTimer = setTimeout(async () => {
		try {
			const response = await axios.get<SparqlResponse>(endpoint, {
				params: { query: buildSuggestionQuery(searchTerm) },
				headers: { Accept: "application/sparql-results+json" },
			});
			if (requestId !== suggestionRequestId) return;

			const normalizedTerm = searchTerm.toLowerCase();
			const molecules = getMolecules(response.data.results.bindings)
				.sort((first, second) => {
					const firstPrefix = first.label.toLowerCase().startsWith(normalizedTerm) ? 0 : 1;
					const secondPrefix = second.label.toLowerCase().startsWith(normalizedTerm) ? 0 : 1;
					return firstPrefix - secondPrefix
						|| first.label.length - second.label.length
						|| first.label.localeCompare(second.label);
				})
				.slice(0, 8);

			for (const [index, molecule] of molecules.entries()) {
				const option = document.createElement("div");
				option.id = `molecule-suggestion-${index}`;
				option.className = "suggestion-option";
				option.setAttribute("role", "option");
				option.setAttribute("aria-selected", "false");
				const name = document.createElement("span");
				name.className = "suggestion-name";
				name.textContent = molecule.label;
				const id = document.createElement("span");
				id.className = "suggestion-id";
				id.textContent = `CHEBI:${molecule.id}`;
				option.append(name, id);
				option.addEventListener("click", () => chooseSuggestion(molecule));
				suggestions.append(option);
			}
			if (molecules.length > 0) {
				suggestions.hidden = false;
				input.setAttribute("aria-expanded", "true");
			}
		} catch {
			closeSuggestions();
		}
	}, 300);
});

function showMessage(message: string, className = "results-message"): void {
	resultPanel.replaceChildren();
	const paragraph = document.createElement("p");
	paragraph.className = className;
	paragraph.textContent = message;
	resultPanel.append(paragraph);
}

function renderResults(molecules: MoleculeResult[]): void {
	resultPanel.replaceChildren();
	if (molecules.length === 0) {
		showMessage("Aucun résultat trouvé. Vérifiez le nom ou l’identifiant ChEBI.");
		return;
	}

	const heading = document.createElement("h2");
	heading.className = "results-heading";
	heading.textContent = `Résultats (${molecules.length})`;
	resultPanel.append(heading);

	for (const molecule of molecules) {
		const article = document.createElement("article");
		article.className = "result-item";

		const name = document.createElement("h3");
		name.className = "result-name";
		name.textContent = molecule.label;
		article.append(name);

		const link = document.createElement("a");
		link.className = "result-id";
		link.href = `https://www.ebi.ac.uk/chebi/searchId.do?chebiId=CHEBI:${encodeURIComponent(molecule.id)}`;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.textContent = `CHEBI:${molecule.id}`;
		link.setAttribute("aria-label", `Ouvrir la fiche ChEBI ${molecule.label}, CHEBI:${molecule.id}`);
		article.append(link);
		resultPanel.append(article);
	}
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	closeSuggestions();
	suggestionRequestId += 1;
	const searchTerm = input.value.trim();
	if (!searchTerm) {
		showMessage("Saisissez un nom de molécule ou un identifiant ChEBI.");
		input.focus();
		return;
	}

	const submitButton = form.querySelector<HTMLButtonElement>("button[type='submit']");
	if (submitButton) submitButton.disabled = true;
	resultPanel.setAttribute("aria-busy", "true");
	showMessage("Recherche en cours...");

	try {
		const exactResponse = await axios.get<SparqlResponse>(endpoint, {
			params: { query: buildExactQuery(searchTerm) },
			headers: { Accept: "application/sparql-results+json" },
		});
		const exactMatches = getMolecules(exactResponse.data.results.bindings);
		if (exactMatches.length > 0) {
			const descendantsResponse = await axios.get<SparqlResponse>(endpoint, {
				params: { query: buildDescendantsQuery(exactMatches.map(({ id }) => id)) },
				headers: { Accept: "application/sparql-results+json" },
			});
			const descendants = getMolecules(descendantsResponse.data.results.bindings);
			renderResults(descendants.length > 0 ? descendants : exactMatches);
		} else {
			const partialResponse = await axios.get<SparqlResponse>(endpoint, {
				params: { query: buildPartialQuery(searchTerm) },
				headers: { Accept: "application/sparql-results+json" },
			});
			renderResults(getMolecules(partialResponse.data.results.bindings));
		}
	} catch (error) {
		console.error("Erreur pendant la recherche ChEBI :", error);
		showMessage("La recherche n’a pas abouti. Veuillez réessayer.", "results-message results-error");
	} finally {
		resultPanel.setAttribute("aria-busy", "false");
		if (submitButton) submitButton.disabled = false;
	}
});

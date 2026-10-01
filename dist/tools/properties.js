/** Properties app: units, MFH buildings, financing, trail documents, valuations, NK letters, visits, rent bank ledger. */
import { z } from 'zod';
import { DESTRUCTIVE_IDEMPOTENT, LOAN_STATUS, READ, WRITE, WRITE_IDEMPOTENT, bytesToBase64, contentBytesToMcp, day, month, teamId, teamIdWith, toolkit, } from '../helpers.js';
const unitId = z.string().uuid().describe('Unit (apartment) UUID from list_units.');
const buildingId = z.string().uuid().describe('Building (MFH) UUID from list_buildings.');
const scopeAll = z.enum(['all']).optional().describe('all = personal + every team space (teamId is then ignored).');
/** Trail document categories the API knows; anything else is stored as "other". */
const DOC_CATEGORY = z.enum([
    'lease', 'rent_increase', 'addendum', 'deposit', 'hausgeld', 'nebenkosten', 'deed',
    'repair', 'energy', 'insurance', 'tax', 'correspondence', 'photo', 'other',
]);
const FLEX_DATE = 'YYYY-MM-DD (DD.MM.YYYY is also accepted)';
const SPACE_KIND = z.enum(['garage', 'parking']).describe('garage, or parking (open Stellplatz).');
const valuationShape = {
    marketValueEuros: z.number().positive().optional().describe('Realistic SALE price in € (not asking price). Required for buildings; for ETW units unless you only update rent.'),
    valueLowEuros: z.number().positive().optional().describe('Lower end of the range'),
    valueHighEuros: z.number().positive().optional().describe('Upper end of the range'),
    saleEurPerSqm: z.number().positive().optional().describe('€/m² living area your value implies or the comps showed'),
    marketRentEurPerSqm: z.number().positive().optional().describe('Units only: local market cold rent €/m² from comparable rent listings'),
    mietspiegelEurPerSqm: z.number().positive().optional().describe('Units only: Mietspiegel cold rent €/m² for this flat'),
    mietspiegelSource: z.string().optional().describe('Units only: which Mietspiegel, year, table/row'),
    method: z.string().describe('How: e.g. "Vergleichswert: Marktbericht Kreis Siegen-Wittgenstein 2026 + 5 Angebote −10 %, Ertragswert-Check Faktor 19"'),
    summary: z.string().describe('1–3 sentences: comps, adjustments (Baujahr, energy, condition, let), why this value'),
    confidence: z.enum(['low', 'medium', 'high']).describe('high only with a Marktbericht figure plus ≥3 good comps'),
    sources: z
        .array(z.object({ url: z.string().url(), title: z.string().optional(), note: z.string().optional().describe('e.g. "3 Zi, 76 m², Bj 1975, 129.000 € Angebot"') }))
        .min(1)
        .describe('Every page you used (listings, Marktbericht, BORIS, Mietspiegel)'),
    asOf: z.string().optional().describe('Valuation date, YYYY-MM-DD. Default today.'),
    dryRun: z.boolean().optional().describe('true = preview with warnings, nothing saved. Always do this first.'),
    force: z.boolean().optional().describe('Overwrite a value from a Gutachten. Only when the user said so.'),
    facts: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Verified facts about the property you found while researching: buildingYear, rooms, squareMeters, energy, heating, heatingYear, energyCertExpires, majorRenovations, garage, coOwnershipShare (units) / buildingYear, energy, heating, energyCertExpires (buildings); anything else (floor, unitsInBuilding, hausgeldEuros, bodenrichtwertEurPerSqm, …) is kept with the research. Add sources: [{url}]. Empty fields are filled; differing stored values come back as factConflicts.'),
    overwriteFacts: z.boolean().optional().describe('Replace stored facts that differ. Only when the user confirmed.'),
};
const visitFields = {
    title: z.string().optional().describe('Short label, e.g. "Besichtigung ETW Siegen".'),
    address: z.string().optional().describe('Destination street and number.'),
    city: z.string().optional().describe('Destination city.'),
    startAddress: z.string().optional().describe('Where the trip started.'),
    roundTrip: z.boolean().optional().describe('Default true: count there and back.'),
    kmRateEuros: z.number().optional().describe('€ per km. Default 0.30.'),
    purpose: z.enum(['viewing', 'follow_up', 'handover', 'other']).optional(),
    status: z.enum(['planned', 'done', 'cancelled']).optional().describe('Only done trips count in the year totals.'),
    notes: z.string().optional(),
};
export const register = (server, client) => {
    const { tool, rawTool } = toolkit(server);
    // ── Valuation ─────────────────────────────────────────────────────────────
    tool('get_valuation_worklist', 'Market-value worklist', 'Start here when the user asks to update market values ("aktualisiere die Marktwerte", Verkehrswert, Marktmiete, Mietspiegel). Returns every property (ETW unit, MFH building, flats inside an MFH) with facts (m², Baujahr, rent, purchase price/date), the current value and rent benchmark, needs (value | rent), flags (missing, stale, portal_average, far_from_recent_purchase, no_rent_benchmark) and `instructions`: the research playbook. Follow it: research every address on the web, then write with set_unit_valuation / set_building_valuation.', {
        teamId,
        scope: scopeAll,
        only: z.enum(['due']).optional().describe('due = only objects that need research'),
    }, READ, (args) => client.getValuationWorklist(args));
    tool('set_unit_valuation', 'Write a unit valuation', 'Write researched market data for one unit. ETW: marketValueEuros (+range) and rent €/m². A flat inside an MFH: rent fields only (its value lives on the building). Send dryRun:true first and check the warnings. Never write a portal city average as the value.', { unitId, ...valuationShape }, WRITE_IDEMPOTENT, ({ unitId, ...body }) => client.setValuation('unit', unitId, body));
    tool('set_building_valuation', 'Write a building valuation', 'Write the researched market value of a whole MFH (Mehrfamilienhaus). Use Ertragswert (annual Kalt × local Rohertragsfaktor) cross-checked with comps and Bodenrichtwert. Send dryRun:true first.', {
        buildingId,
        ...valuationShape,
        marketValueEuros: z.number().positive().describe('Realistic SALE price of the whole building in €'),
    }, WRITE_IDEMPOTENT, ({ buildingId, ...body }) => client.setValuation('building', buildingId, body));
    // ── Units + buildings ─────────────────────────────────────────────────────
    tool('list_units', 'List apartments', 'List Properties apartments. Pass teamId for a space such as Chi Ross. scope=all lists every space. buildingId / kind=etw|building for MFH vs ETW. financing filters by loanStatus. summary.remainingDebtEuros counts each building loan once — never SUM remainingDebt across units of the same building.', {
        teamId,
        scope: scopeAll,
        buildingId: buildingId.optional().describe('Only the units of this MFH (UUID from list_buildings).'),
        kind: z.enum(['etw', 'building']).optional().describe('etw = standalone condos; building = flats that belong to an MFH.'),
        financing: z
            .enum(['debt_free', 'active', 'unknown', 'fixed_rate_soon', 'all'])
            .optional()
            .describe('Filter: debt_free, active, unknown, or fixed_rate_soon (Zinsbindung in 24 months)'),
    }, READ, (args) => client.listUnits(args));
    tool('list_buildings', 'List MFH buildings', 'List MFH buildings (one purchase + one loan + Wohnungen + garage spaces). Pass teamId for Chi Ross. Do not SUM remainingDebt across the nested units.', { teamId, scope: scopeAll }, READ, (args) => client.listBuildings(args));
    tool('get_building', 'Get one MFH building', 'One MFH with units, garage spaces, and sums (Kalt, Warm, Rate, Überschuss, Leerstand). House loan is building.loan — not on each Wohnung.', { id: buildingId }, READ, ({ id }) => client.getBuilding(id));
    tool('create_building', 'Create an MFH building', 'Create an MFH. name required. Optional address, city, teamId, purchasePriceEuros, nested loan (bank, remainingDebtEuros, monthlyPaymentEuros, loanStatus), unitIds[], spaces[{kind,label,occupancyUnitId}]. Never invent remaining debt.', {
        name: z.string().min(1).max(200),
        address: z.string().optional().describe('Street and number.'),
        city: z.string().optional(),
        teamId: teamIdWith('Creates the building in that space.'),
        purchasePriceEuros: z.number().optional(),
        loan: z
            .object({
            bank: z.string().optional(),
            account: z.string().optional().describe('Loan account number at the bank.'),
            remainingDebtEuros: z.number().optional().describe('Restschuld from a bank document. Never invent.'),
            monthlyPaymentEuros: z.number().optional(),
            fixedRateEnd: z.string().optional().describe('End of the fixed-rate period (Zinsbindung), YYYY-MM-DD.'),
            ratePercent: z.string().optional().describe('Interest rate as text, e.g. "3.45".'),
            loanStatus: LOAN_STATUS.optional(),
            notes: z.string().optional(),
        })
            .optional()
            .describe('The one house loan of this MFH.'),
        unitIds: z.array(z.string().uuid()).optional().describe('Existing unit UUIDs to move into this building.'),
        spaces: z
            .array(z.object({
            kind: SPACE_KIND.optional(),
            label: z.string().describe('e.g. "Garage 3".'),
            occupancyUnitId: z.string().uuid().optional().describe('Unit UUID it is rented with.'),
            notes: z.string().optional(),
            rentEuros: z.number().optional().describe('Monthly rent for the space in €.'),
        }))
            .optional()
            .describe('Garages / parking spaces to create with the building.'),
    }, WRITE, (body) => client.createBuilding(body));
    tool('update_building', 'Update an MFH building', 'Patch an MFH including the single house loan. Pass only the fields to change. Never invent remaining debt.', {
        id: buildingId,
        name: z.string().min(1).max(200).optional(),
        address: z.string().optional().describe('Street and number.'),
        city: z.string().optional(),
        purchasePriceEuros: z.number().nullable().optional(),
        remainingDebtEuros: z.number().nullable().optional().describe('Restschuld of the house loan from a bank document; null clears it. Never invent.'),
        monthlyPaymentEuros: z.number().nullable().optional().describe('Monthly loan rate in €.'),
        bankName: z.string().optional(),
        loanStatus: LOAN_STATUS.optional(),
        loanNotes: z.string().optional(),
        nonRecoverableCostsEuros: z.number().nullable().optional().describe('Monthly owner costs that cannot be passed on to tenants, in €.'),
    }, WRITE_IDEMPOTENT, ({ id, ...patch }) => client.updateBuilding(id, patch));
    tool('list_building_documents', 'List building documents', 'List MFH building trail files (Kaufvertrag, Nutzungsänderung, Exposé). Not unit leases.', { buildingId }, READ, ({ buildingId }) => client.listBuildingDocuments(buildingId));
    tool('create_building_document', 'Add a building document', 'Add a building-level trail file (Kaufvertrag, Nutzungsänderung, Exposé). Do not hang these on a Wohnung. JSON contentBase64 or fileName+mimeType.', {
        buildingId,
        title: z.string().optional(),
        category: DOC_CATEGORY.optional().describe('Usually deed, energy or other. Omit to let the server infer it from the title.'),
        documentDate: z.string().optional().describe(`Date on the document, ${FLEX_DATE}.`),
        notes: z.string().optional(),
        fileName: z.string().optional().describe('e.g. "Kaufvertrag.pdf".'),
        mimeType: z.string().optional().describe('e.g. "application/pdf".'),
        contentBase64: z.string().optional().describe('Raw file bytes as base64.'),
    }, WRITE, ({ buildingId, ...body }) => client.createBuildingDocument(buildingId, body));
    rawTool('download_building_document', 'Download a building document', 'Download one building trail file. Text and images come back inline, other files (PDF) as an embedded resource.', { buildingId, docId: z.string().uuid().describe('Document UUID from list_building_documents.') }, READ, async ({ buildingId, docId }) => {
        const content = await client.downloadBuildingDocument(buildingId, docId);
        return {
            content: [
                { type: 'text', text: `Downloaded ${content.size} bytes (${content.mimeType})` },
                ...contentBytesToMcp(content, `achi://files/${docId}`),
            ],
        };
    });
    tool('create_building_space', 'Add a garage / parking space', 'Add a garage or Stellplatz on an MFH. occupancyUnitId = with-rented to a Wohnung (Cretu 3+4).', {
        buildingId,
        label: z.string().min(1).describe('e.g. "Garage 3".'),
        kind: SPACE_KIND.optional(),
        occupancyUnitId: z.string().uuid().optional().describe('Unit UUID of the Wohnung it is rented with. Must be a unit of this building.'),
        notes: z.string().optional(),
        rentEuros: z.number().optional().describe('Monthly rent for the space in €.'),
    }, WRITE, ({ buildingId, ...body }) => client.createBuildingSpace(buildingId, body));
    tool('update_building_space', 'Update a garage / parking space', 'Patch a garage or Stellplatz of an MFH (ids are in get_building → spaces). Fields you leave out keep their stored values.', {
        spaceId: z.string().uuid().describe('Space UUID from get_building.'),
        label: z.string().min(1).optional().describe('e.g. "Garage 3".'),
        kind: SPACE_KIND.optional(),
        occupancyUnitId: z.string().uuid().nullable().optional().describe('Unit UUID of the Wohnung it is rented with (must be in the same building); null = not tied to a unit.'),
        notes: z.string().nullable().optional(),
        rentEuros: z.number().nullable().optional().describe('Monthly rent for the space in €; null clears it.'),
    }, WRITE_IDEMPOTENT, ({ spaceId, ...body }) => client.updateBuildingSpace(spaceId, body));
    tool('delete_building_space', 'Delete a garage / parking space', 'Permanently remove a garage or Stellplatz from an MFH. Cannot be undone — only when the user asked for it.', { spaceId: z.string().uuid().describe('Space UUID from get_building.') }, DESTRUCTIVE_IDEMPOTENT, ({ spaceId }) => client.deleteBuildingSpace(spaceId));
    // ── Financing ─────────────────────────────────────────────────────────────
    tool('get_unit_financing', 'Get unit financing', 'Document-based financing suggestions, named loans, and event history for one apartment. Apply a suggestion only after the user confirms. Never invent remaining debt.', { unitId }, READ, ({ unitId }) => client.getUnitFinancing(unitId));
    tool('apply_financing_suggestion', 'Apply a financing suggestion', 'Apply one financing suggestion from get_unit_financing after the user confirmed. Writes loanStatus / Grundschuld / remainingDebt only when the document supports it.', { unitId, key: z.string().describe('suggestion.key from get_unit_financing.') }, WRITE_IDEMPOTENT, ({ unitId, key }) => client.applyFinancingSuggestion(unitId, key));
    tool('dismiss_financing_suggestion', 'Dismiss a financing suggestion', 'Dismiss a financing suggestion so it is not offered again.', { unitId, key: z.string().describe('suggestion.key from get_unit_financing.') }, WRITE_IDEMPOTENT, ({ unitId, key }) => client.dismissFinancingSuggestion(unitId, key));
    tool('extract_loan_from_docs', 'Read Restschuld from documents', 'Read Restschuld from a Tilgungsplan PDF in the property trail. Use dryRun=true first. Does not invent an amount if the PDF has no labeled Restschuld.', {
        unitId,
        dryRun: z.boolean().optional().describe('true = show what would be written, save nothing.'),
        force: z.boolean().optional().describe('Overwrite a remaining debt that is already stored. Only when the user said so.'),
    }, WRITE_IDEMPOTENT, ({ unitId, dryRun, force }) => client.extractLoanFromDocs(unitId, { dryRun, force }));
    tool('list_unit_loans', 'List unit loans', 'Named loans on a unit (more than one bank).', { unitId }, READ, ({ unitId }) => client.listUnitLoans(unitId));
    tool('create_unit_loan', 'Add a unit loan', 'Add a named loan on a unit. Never invent remaining debt.', {
        unitId,
        bankName: z.string().optional(),
        status: LOAN_STATUS.optional(),
        remainingDebtEuros: z.number().nullable().optional().describe('Restschuld from a bank document. Never invent.'),
        monthlyPaymentEuros: z.number().nullable().optional(),
        fixedRateEndDate: z.string().optional().describe('End of the fixed-rate period (Zinsbindung), YYYY-MM-DD.'),
        notes: z.string().optional(),
    }, WRITE, ({ unitId, ...body }) => client.createUnitLoan(unitId, body));
    // ── Unit read / write / versions ──────────────────────────────────────────
    tool('get_unit', 'Get one apartment', 'Load one apartment: tenant, rent, address, financing (loanStatus, hasActiveLoan, Grundschuld), trail folder. Does not invent Anschrift, IBAN, or remaining debt.', { id: unitId }, READ, ({ id }) => client.getUnit(id));
    tool('update_unit', 'Update an apartment', 'Write Properties fields (squareMeters, rooms, rent, tenant, loanStatus, bankName, remainingDebtEuros, grundschuldExists, notes, …). Pass only the fields to change. Snapshots the current row first so restore_unit can undo a bad write. Always pass versionReason. Never invent remaining debt. Use ifUpdatedAt from get_unit.updatedAt to avoid clobbering. The four loan fields each have a legacy alias (loanBank, loanBalanceEuros, loanMonthlyPaymentEuros, loanFixedUntil): use the preferred name and never send both.', {
        id: unitId,
        squareMeters: z.string().optional().describe('Living area in m² as a string, number only with a dot decimal, e.g. "76.5" (no "m²").'),
        rooms: z.string().optional().describe('Number of rooms as a string, e.g. "3" or "2.5".'),
        name: z.string().optional().describe('Display name of the unit.'),
        address: z.string().optional().describe('Street and number.'),
        city: z.string().optional(),
        rentEuros: z.number().optional().describe('Monthly Nettokaltmiete in €.'),
        nebenkostenEuros: z.number().optional().describe('Monthly Nebenkosten prepayment by the tenant in €.'),
        hausgeldEuros: z.number().optional().describe('Monthly Hausgeld paid to the WEG in €.'),
        tenantName: z.string().optional(),
        tenantEmail: z.string().optional(),
        leaseStart: z.string().optional().describe('Start of the current lease, YYYY-MM-DD.'),
        purchasePriceEuros: z.number().nullable().optional(),
        purchaseDate: z.string().optional().describe('YYYY-MM-DD.'),
        marketValueEuros: z.number().nullable().optional().describe('Prefer set_unit_valuation, which also stores sources.'),
        marketValueDate: z.string().optional().describe('YYYY-MM-DD.'),
        marketValueSource: z.string().optional(),
        notes: z.string().optional(),
        todo: z.string().optional(),
        extras: z.string().optional(),
        rentAgreementNotes: z.string().optional(),
        propertyManagement: z.string().optional().describe('Hausverwaltung: name and contact.'),
        coOwnershipShare: z.string().optional().describe('Miteigentumsanteil as text, e.g. "45/1000".'),
        garage: z.string().optional(),
        buildingYear: z.string().optional().describe('Baujahr, e.g. "1975".'),
        heating: z.string().optional(),
        energy: z.string().optional().describe('Energy class / value from the Energieausweis.'),
        lastRentIncrease: z.string().optional().describe('Date of the last rent increase, YYYY-MM-DD.'),
        loanStatus: LOAN_STATUS
            .optional()
            .describe('Structured financing status. Never invent remaining debt.'),
        hasActiveLoan: z.boolean().optional(),
        bankName: z.string().optional().describe('Preferred. Lending bank.'),
        loanBank: z.string().optional().describe('(alias of bankName) — do not send both.'),
        remainingDebtEuros: z.number().nullable().optional().describe('Preferred. Restschuld in € from a bank document; null clears it. Never invent.'),
        loanBalanceEuros: z.number().nullable().optional().describe('(alias of remainingDebtEuros) — do not send both.'),
        monthlyPaymentEuros: z.number().nullable().optional().describe('Preferred. Monthly loan rate in €.'),
        loanMonthlyPaymentEuros: z.number().nullable().optional().describe('(alias of monthlyPaymentEuros) — do not send both.'),
        fixedRateEndDate: z.string().optional().describe('Preferred. End of the fixed-rate period (Zinsbindung), YYYY-MM-DD.'),
        loanFixedUntil: z.string().optional().describe('(alias of fixedRateEndDate) — do not send both.'),
        grundschuldExists: z.boolean().nullable().optional(),
        grundschuldAmountEuros: z.number().nullable().optional(),
        loanNotes: z.string().optional(),
        versionReason: z.string().optional().describe('Always pass this: why the write happens, e.g. "Restschuld from Tilgungsplan 2026". Stored on the snapshot.'),
        ifUpdatedAt: z.string().optional().describe('ISO 8601 updatedAt from get_unit — the write fails with 409 if the unit changed since.'),
    }, WRITE_IDEMPOTENT, ({ id, ...body }) => client.updateUnit(id, body));
    tool('list_unit_versions', 'List unit versions', 'List Properties unit snapshots (newest first). Use restore_unit if an earlier write was wrong.', {
        unitId,
        limit: z.number().int().min(1).max(50).optional().describe('How many snapshots (1–50).'),
    }, READ, ({ unitId, limit }) => client.listUnitVersions(unitId, { limit }));
    tool('restore_unit', 'Restore a unit version', 'Revert a Properties unit to a prior snapshot. The live row is snapshotted first so this restore can also be undone.', {
        unitId,
        versionId: z.string().uuid().describe('Version UUID from list_unit_versions.'),
    }, WRITE, ({ unitId, versionId }) => client.restoreUnit(unitId, versionId));
    // ── Unit trail documents ──────────────────────────────────────────────────
    tool('list_unit_documents', 'List unit documents', 'List the Properties document trail for an apartment (HV, heating, tax, prior NK letters).', { unitId }, READ, ({ unitId }) => client.listUnitDocuments(unitId));
    tool('create_unit_document', 'Add a unit document', 'Create a Properties trail document (NK letter, HV file, …). Send contentBase64 for the PDF/file. Use this instead of asking the user to re-attach. Uploading into Achi Properties/{unit} also creates a trail row.', {
        unitId,
        title: z.string().optional(),
        category: DOC_CATEGORY.optional().describe('Omit to let the server infer it from the title.'),
        documentDate: z.string().optional().describe(`${FLEX_DATE} — the letter/receipt date, not 31 Dec of the settlement year`),
        notes: z.string().optional(),
        fileName: z.string().optional().describe('e.g. "Mietvertrag.pdf".'),
        mimeType: z.string().optional().describe('e.g. "application/pdf".'),
        contentBase64: z.string().optional().describe('Raw file bytes as base64'),
        driveFileId: z.string().uuid().optional().describe('UUID of a file already in Drive, instead of contentBase64.'),
        occupancyId: z.string().uuid().optional().describe('Tenancy UUID (get_unit → occupancies) this document belongs to.'),
        periodFrom: z.string().optional().describe('Start of the period the document covers, YYYY-MM-DD.'),
        periodTo: z.string().optional().describe('End of the period the document covers, YYYY-MM-DD.'),
        year: z.number().int().optional().describe('Settlement / tax year, e.g. 2025.'),
        effectiveOn: z.string().optional().describe('When the rent in this document starts (YYYY-MM-DD)'),
        rentEurosAfter: z.number().optional().describe('Nettokalt after this document. Required for Proof of Revenue.'),
        isCurrentLease: z.boolean().optional(),
        supersedesDocumentId: z.string().uuid().optional().describe('UUID of the trail document this one replaces.'),
    }, WRITE, ({ unitId, ...body }) => client.createUnitDocument(unitId, body));
    tool('schedule_rent_change', 'Schedule a rent change', 'Schedule a future cold-rent change (Mieterhöhung ab …) for a unit. Creates a rent_increase trail document with effectiveOn and rentEurosAfter; the unit then shows nextRentChange and its Kalt switches automatically on that day (Europe/Berlin). Attach the signed letter later with update_unit_document or create_unit_document. To cancel, delete that document.', {
        unitId,
        effectiveOn: z.string().describe('First day of the new rent, YYYY-MM-DD (must be in the future), e.g. 2027-01-01'),
        rentEurosAfter: z.number().positive().describe('New Nettokaltmiete in euros per month, e.g. 456'),
        letterDate: z.string().optional().describe('Date of the increase letter, YYYY-MM-DD. Default today.'),
        title: z.string().optional().describe('Default: "Mieterhöhung ab DD.MM.YYYY: N €"'),
        notes: z.string().optional(),
    }, WRITE, (args) => {
        const [y, m, d] = args.effectiveOn.split('-');
        return client.createUnitDocument(args.unitId, {
            title: args.title || `Mieterhöhung ab ${d}.${m}.${y}: ${args.rentEurosAfter} €`,
            category: 'rent_increase',
            documentDate: args.letterDate || new Date().toISOString().slice(0, 10),
            effectiveOn: args.effectiveOn,
            rentEurosAfter: args.rentEurosAfter,
            notes: args.notes,
            source: 'other',
        });
    });
    tool('update_unit_document', 'Update a unit document', 'Patch a trail document’s title, documentDate, category, effectiveOn, rentEurosAfter, isCurrentLease, or notes. Use this to tag a lease/increase for Proof of Revenue — do not ask the user to edit the UI.', {
        unitId,
        docId: z.string().uuid().describe('Document UUID from list_unit_documents.'),
        title: z.string().optional(),
        documentDate: z.string().optional().describe(`${FLEX_DATE} — the letter/receipt date, not 31 Dec of the settlement year`),
        notes: z.string().nullable().optional(),
        category: DOC_CATEGORY.optional(),
        effectiveOn: z.string().optional().describe('When the rent in this document starts, YYYY-MM-DD.'),
        rentEurosAfter: z.number().nullable().optional().describe('Nettokalt after this document, in €.'),
        isCurrentLease: z.boolean().optional(),
        supersedesDocumentId: z.string().uuid().nullable().optional().describe('UUID of the trail document this one replaces.'),
    }, WRITE_IDEMPOTENT, ({ unitId, docId, ...body }) => client.updateUnitDocument(unitId, docId, body));
    tool('create_proof_of_revenue', 'Build a Proof of Revenue pack', 'Build Mietaufstellung.pdf + Vertragstrail.zip from the written trail. Ist-Kalt is rentEurosAfter on lease/increase/addendum as of asOf — never invent rent. Default scope is occupied ETW; pass buildingId for one MFH. dryRun=true to preview. No bank mail. Share links expire in 14 days.', {
        teamId,
        buildingId: buildingId.optional().describe('Limit the pack to this MFH (UUID from list_buildings).'),
        unitIds: z.array(z.string().uuid()).optional().describe('Limit the pack to these unit UUIDs.'),
        asOf: z.string().optional().describe('YYYY-MM-DD. Default today. Hadamar 456 € only on/after 2026-12-01 if tagged.'),
        writtenOnly: z.boolean().optional().describe('Default true — skip units without rentEurosAfter'),
        includeVacant: z.boolean().optional(),
        dryRun: z.boolean().optional().describe('true = summary and mismatches only, no files stored.'),
        password: z.string().optional().describe('Protects the share links.'),
        pdfOnly: z.boolean().optional().describe('Light: Mietaufstellung.pdf only, no ZIP'),
        includeFinancing: z.boolean().optional(),
        includeTenants: z
            .boolean()
            .optional()
            .describe('Default true. False omits tenant names (privacy for financing advisors).'),
        includeMarket: z
            .boolean()
            .optional()
            .describe('Extra table: market value, remaining debt, source; then totals. MFH loan once.'),
    }, WRITE, (args) => client.createProofOfRevenue(args));
    rawTool('download_unit_document', 'Download a unit document', 'Download one trail document (PDF/ODT). Use this instead of asking the user to re-attach HV or heating files.', { unitId, docId: z.string().uuid().describe('Document UUID from list_unit_documents.') }, READ, async ({ unitId, docId }) => {
        const content = await client.downloadUnitDocument(unitId, docId);
        return {
            content: [
                { type: 'text', text: `Downloaded ${content.size} bytes (${content.mimeType})` },
                ...contentBytesToMcp(content, `achi://files/${docId}`),
            ],
        };
    });
    // ── Payments, letterhead, bank ────────────────────────────────────────────
    tool('list_unit_payments', 'List unit rent payments', 'Bank-statement payment trail for an apartment (cold/warm/NK). GET only — do not PATCH. Amount corrections belong in Achi Zahlungen / the matching job.', {
        unitId,
        from: month('First month, inclusive.').optional(),
        to: month('Last month, inclusive.').optional(),
    }, READ, ({ unitId, from, to }) => client.listUnitPayments(unitId, { from, to }));
    tool('get_landlord_profile', 'Get landlord letterhead', 'Stored Vermieter letterhead for a space. Empty fields stay empty — never invent legal name, street, or IBAN.', { teamId }, READ, (args) => client.landlordProfile(args));
    tool('list_bank_transactions', 'List rent bank lines (Properties)', 'Properties app, rent bank ledger: the Kontoauszug lines (date, amountEuros, kind, counterparty, purpose) of a team space\'s German rental account. Use it to check which rents and payments really arrived. Requires teamId. For the Financials app\'s USD books (Mercury/Wise lines, receipts, categorising) use list_book_transactions instead.', {
        teamId: z.string().uuid().describe('Required here. Space/team UUID from list_teams.'),
        from: month('First month, inclusive.').optional(),
        to: month('Last month, inclusive.').optional(),
    }, READ, (args) => client.listPropertiesBankTransactions(args));
    // ── NK letters + settlements ──────────────────────────────────────────────
    rawTool('create_nk_letter', 'Create an NK letter PDF', [
        'Compile a tenant Nebenkostenabrechnung PDF on the Achi server (no browser pdf.js).',
        'Pass recoverable line items only. Do not invent amounts, Anschrift, or IBAN.',
        'Do not include Eigentümerkosten leftovers or Quellenangabe — the server strips them.',
        'If tenants changed mid-year, pass occupancyId + periodFrom + periodTo so this letter does not overwrite the other stay.',
        'Returns a PDF. Also files the unit trail and a settlement (x-achi-nk-settlement-id).',
    ].join(' '), {
        unitId,
        year: z.number().int().min(2000).max(2100).describe('Settlement year, e.g. 2025.'),
        occupancyId: z.string().uuid().optional().describe('Tenancy UUID (get_unit → occupancies) when tenants changed mid-year.'),
        periodFrom: z.string().optional().describe('YYYY-MM-DD stay start in this settlement year'),
        periodTo: z.string().optional().describe('YYYY-MM-DD stay end in this settlement year'),
        createSettlement: z.boolean().optional(),
        prepaidEuros: z.number().optional().describe('NK prepayments the tenant made in the period, in €.'),
        greeting: z.string().optional(),
        title: z.string().optional(),
        notes: z.array(z.string()).optional(),
        items: z
            .array(z.object({
            posten: z.string(),
            schluessel: z.string().optional(),
            gesamt: z.string().optional(),
            ihrAnteilEinheiten: z.string().optional(),
            betrag: z.string().optional(),
            ihrAnteil: z.string(),
        }))
            .min(1),
    }, WRITE, async (args) => {
        const pdf = await client.createNkLetter(args);
        return {
            content: [
                {
                    type: 'text',
                    text: `NK letter PDF ${pdf.size} bytes.${pdf.settlementId ? ` settlement=${pdf.settlementId}` : ''}${pdf.documentId ? ` document=${pdf.documentId}` : ''}`,
                },
                {
                    type: 'resource',
                    resource: {
                        uri: `achi://letters/nk/${args.unitId}/${args.year}`,
                        mimeType: 'application/pdf',
                        blob: bytesToBase64(pdf.bytes),
                    },
                },
            ],
        };
    });
    tool('list_nk_settlements', 'List NK settlements', 'List tenant NK settlements for an apartment and year. Mid-year move-out → two rows, not one.', {
        unitId,
        year: z.number().int().min(2000).max(2100).optional().describe('Settlement year, e.g. 2025. Omit for all years.'),
    }, READ, ({ unitId, year }) => client.listNkSettlements(unitId, { year }));
    tool('update_nk_settlement', 'Update an NK settlement', 'Patch one NK settlement (status, amounts, notes). Does not change other tenants in the same year.', {
        unitId,
        nkId: z.string().uuid().describe('Settlement UUID from list_nk_settlements.'),
        status: z.enum(['draft', 'ready_to_send', 'sent', 'paid', 'disputed']).optional(),
        prepaidEuros: z.number().nullable().optional(),
        totalCostsEuros: z.number().nullable().optional(),
        balanceEuros: z.number().nullable().optional().describe('Positive = tenant owes, negative = refund.'),
        notes: z.string().nullable().optional(),
        documentId: z.string().uuid().optional().describe('Trail document UUID of the letter.'),
    }, WRITE_IDEMPOTENT, ({ unitId, nkId, ...body }) => client.updateNkSettlement(unitId, nkId, body));
    // ── Viewing trips ─────────────────────────────────────────────────────────
    tool('list_property_visits', 'List viewing trips', 'List Besichtigungsfahrten (viewing trips). Year totals count completed trips only. Never invent kilometres.', {
        teamId,
        year: z.number().int().min(2000).max(2100).optional().describe('Calendar year, e.g. 2026.'),
    }, READ, (args) => client.listPropertyVisits(args));
    tool('create_property_visit', 'Log a viewing trip', 'Log a viewing trip. distanceKm is one-way. roundTrip defaults true (Hin- und Rückfahrt, deductible ×2). Never invent kilometres. Default rate 0.30 €/km.', {
        teamId,
        visitedOn: day('Day of the trip.').optional(),
        ...visitFields,
        distanceKm: z.number().nullable().optional().describe('One-way kilometres. Do not invent.'),
    }, WRITE, (args) => client.createPropertyVisit(args));
    tool('update_property_visit', 'Update a viewing trip', 'Update a viewing trip (status, distanceKm, roundTrip, notes). Never invent kilometres.', {
        id: z.string().uuid().describe('Visit UUID from list_property_visits.'),
        visitedOn: day('Day of the trip.').optional(),
        ...visitFields,
        distanceKm: z.number().nullable().optional().describe('One-way kilometres.'),
    }, WRITE_IDEMPOTENT, ({ id, ...body }) => client.updatePropertyVisit(id, body));
};

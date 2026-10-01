/** Financials app: the space's USD books — bank lines, receipts, journals, departments, reports. */
import { z } from 'zod';
import { DESTRUCTIVE, READ, WRITE, WRITE_IDEMPOTENT, day, teamId, toolkit } from '../helpers.js';
const txnId = z.string().uuid().describe('Bank line UUID from list_book_transactions.');
const asOf = day('Balance date. Default today.').optional();
const periodFrom = day('First day of the period, inclusive. Default 1 Jan of the current year.').optional();
const periodTo = day('Last day of the period, inclusive. Default 31 Dec of the current year.').optional();
const dryRun = z.boolean().optional().describe('true = preview the result, nothing is written.');
export const register = (server, client) => {
    const { tool } = toolkit(server);
    // ── Book + bank lines ─────────────────────────────────────────────────────
    tool('get_financials_book', 'Open the books', 'Open the space\'s USD books: chart of accounts, bank pots (ids for import_bank_csv), coding rules, flags. Never invent FX rates.', { teamId }, READ, (args) => client.getFinancialsBook(args));
    tool('list_book_transactions', 'List bank lines (Financials books)', 'Financials app, USD books: the bank lines imported from Mercury/Wise with their state, flags and attached receipts (documents[]). Use it for bookkeeping — what still needs categorising, a receipt or a transfer match. For the Properties app\'s German rent Kontoauszug (did the tenant pay?) use list_bank_transactions instead.', {
        teamId,
        state: z
            .enum(['uncategorized', 'suggested', 'categorized', 'excluded', 'transfer'])
            .optional()
            .describe('Only lines in this state. uncategorized and suggested are the open inbox.'),
        missingReceipt: z.boolean().optional().describe('true = only expenses still needing an invoice.'),
    }, READ, (args) => client.listBookTransactions(args));
    tool('import_bank_csv', 'Import a bank CSV', 'Import a Mercury or Wise CSV export as-is. Idempotent. dryRun previews. A Wise rate counts only for conversions to/from USD; other foreign lines are flagged missing_usd_rate with USD left null (use set_transaction_rate).', {
        bankId: z.string().uuid().describe('Bank pot UUID from get_financials_book.'),
        csv: z.string().describe('The CSV export, unmodified, as text.'),
        dryRun,
        teamId,
    }, WRITE_IDEMPOTENT, (args) => client.importBankCsv(args.bankId, args));
    tool('categorize_transaction', 'Categorize a bank line', 'Post a balanced USD journal for a bank line, once (409 ALREADY_POSTED on retry). Fails with missing_rate if a foreign line has no rate. dryRun previews. Undo with unpost_transaction.', {
        id: txnId,
        teamId,
        accountId: z.string().uuid().optional().describe('GL account UUID from get_financials_book. Pass this or accountCode.'),
        accountCode: z.string().optional().describe('GL account code from get_financials_book, e.g. "6100". Pass this or accountId.'),
        departmentCode: z.string().optional().describe('Department inside the company (e.g. NH, EGS); omit for company-level'),
        dryRun,
    }, WRITE, (args) => client.categorizeTransaction(args.id, args));
    tool('exclude_transaction', 'Exclude a bank line', 'Exclude an open line that belongs to another entity (e.g. Chi Ross / DE rentals in the Elania books).', { id: txnId, teamId }, WRITE, ({ id, teamId }) => client.excludeTransaction(id, { teamId }));
    tool('set_transaction_rate', 'Set a USD rate on a bank line', 'Record a USD rate (USD per 1 unit of the line currency) on an open foreign line, e.g. from the Wise app or invoice. Stored as a manual rate and audited. Only from a real source — never guess.', { id: txnId, rate: z.string().describe('e.g. "1.0850"'), teamId }, WRITE_IDEMPOTENT, ({ id, rate, teamId }) => client.setTransactionRate(id, { rate, teamId }));
    // ── Receipts ──────────────────────────────────────────────────────────────
    tool('upload_receipt', 'Upload a receipt', 'Upload a receipt or invoice (PDF/JPEG/PNG/HEIC/WebP, max 25 MB) from a local path into the books. Same file twice is stored once. Pass transactionId to attach it, or read the receipt and pass amount/date/vendor to get matches[] (autoMatch attaches only a single clear match).', {
        path: z.string().min(1).describe('Absolute path on this machine.'),
        transactionId: txnId.optional().describe('Bank line UUID to attach the receipt to.'),
        amount: z.string().optional().describe('Receipt total as printed, e.g. "59.99"'),
        currency: z.string().optional().describe('ISO 4217 code as printed on the receipt, e.g. "EUR".'),
        date: z.string().optional().describe('Receipt date YYYY-MM-DD'),
        vendor: z.string().optional(),
        autoMatch: z.boolean().optional().describe('true = attach when exactly one bank line clearly fits.'),
        filename: z.string().optional().describe('Defaults to the path basename.'),
        mimeType: z.string().optional().describe('e.g. "application/pdf".'),
        teamId,
    }, WRITE_IDEMPOTENT, (args) => client.uploadReceipt(args));
    tool('attach_receipt', 'Attach a receipt to a bank line', 'Attach an uploaded receipt (documentId from upload_receipt or list_receipts) to a bank line. Idempotent; clears missing_invoice_pdf.', { transactionId: txnId, documentId: z.string().uuid().describe('Receipt UUID from upload_receipt or list_receipts.'), teamId }, WRITE_IDEMPOTENT, ({ transactionId, documentId, teamId }) => client.attachReceipt(transactionId, documentId, { teamId }));
    tool('detach_receipt', 'Detach a receipt from a bank line', 'Remove a receipt from a bank line (the file stays in the books).', { transactionId: txnId, documentId: z.string().uuid().describe('Receipt UUID from list_receipts.'), teamId }, WRITE_IDEMPOTENT, ({ transactionId, documentId, teamId }) => client.detachReceipt(transactionId, documentId, { teamId }));
    tool('list_receipts', 'List receipts', 'List receipts in the books, or the ones on one transaction. hasFile=false means only a sha256 was registered.', { transactionId: txnId.optional().describe('Only the receipts on this bank line.'), teamId }, READ, (args) => client.listReceipts(args));
    tool('find_receipt_matches', 'Find bank lines for a receipt', 'Bank lines a receipt belongs to. Read the receipt yourself and pass its total, date and vendor; returns ranked matches and a confident id when one clearly fits.', {
        amount: z.string().describe('Receipt total as printed, e.g. "59.99".'),
        currency: z.string().optional().describe('ISO 4217 code, e.g. "EUR".'),
        date: day('Receipt date.').optional(),
        vendor: z.string().optional(),
        teamId,
    }, READ, (args) => client.findReceiptMatches(args));
    // ── Transfers, undo, journals ─────────────────────────────────────────────
    tool('find_transfer_matches', 'Find the other side of a transfer', 'Open lines in the book\'s other accounts that look like the other side of this transfer (Mercury → Wise, Wise EUR → USD).', { id: txnId, teamId }, READ, (args) => client.findTransferMatches(args.id, args));
    tool('post_transfer', 'Post a transfer between own accounts', 'Post two bank lines as one transfer between own accounts (no P&L). A currency conversion\'s USD gap goes to Exchange Gain/Loss; dryRun previews the journal. Undo with unpost_transaction.', {
        id: txnId,
        counterTransactionId: z.string().uuid().describe('UUID of the other side, from find_transfer_matches.'),
        dryRun,
        teamId,
    }, WRITE, (args) => client.postTransfer(args.id, args));
    tool('unpost_transaction', 'Undo a posted bank line', 'Undo a posted bank line or transfer: reverses its journal (kept for audit) and returns the line(s) to the inbox. Give a memo saying why.', {
        id: txnId,
        memo: z.string().optional().describe('Why it is undone.'),
        occurredOn: day('Date of the reversing entry; only needed when the original period is locked.').optional(),
        teamId,
    }, WRITE, (args) => client.unpostTransaction(args.id, args));
    tool('reverse_journal', 'Reverse a journal', 'Reverse any journal (manual, opening, bank, transfer) with a mirror entry; both stay in the ledger for good. occurredOn is needed only when the original period is locked.', {
        id: z.string().uuid().describe('Journal UUID from list_journals.'),
        memo: z.string().optional().describe('Why it is reversed.'),
        occurredOn: day('Date of the reversing entry; only needed when the original period is locked.').optional(),
        teamId,
    }, DESTRUCTIVE, (args) => client.reverseJournal(args.id, args));
    tool('post_journal', 'Post a manual journal', 'Post a balanced manual journal in USD. Posted entries are permanent (they can only be reversed with reverse_journal), so use dryRun first. kind "opening" enters opening balances (once per book). EUR accounts need nativeAmount per line.', {
        occurredOn: day('Booking date.'),
        memo: z.string().describe('What the entry is for.'),
        kind: z.enum(['manual', 'opening']).optional().describe('Default manual.'),
        lines: z.array(z.object({
            accountCode: z.string().describe('GL account code from get_financials_book.'),
            debit: z.string().optional().describe('USD amount as a string, e.g. "120.00". Each line has a debit or a credit.'),
            credit: z.string().optional().describe('USD amount as a string, e.g. "120.00".'),
            nativeAmount: z.string().optional().describe('Amount in the account\'s own currency; required for EUR accounts.'),
            departmentCode: z.string().optional().describe('Department code (list_departments); omit for company-level.'),
        })).min(2).describe('At least two lines; total debits must equal total credits.'),
        dryRun,
        teamId,
    }, DESTRUCTIVE, (args) => client.postJournal(args));
    tool('list_journals', 'List journals (general ledger)', 'General ledger: journals with lines, newest first. Filter by date range or account code.', {
        from: day('First booking day, inclusive.').optional(),
        to: day('Last booking day, inclusive.').optional(),
        accountCode: z.string().optional().describe('Only journals touching this GL account code.'),
        limit: z.number().int().optional().describe('Journals to return, 1–500. Default 100.'),
        teamId,
    }, READ, (args) => client.listJournals(args));
    // ── Reports ───────────────────────────────────────────────────────────────
    tool('get_trial_balance', 'Trial balance', 'Trial balance in USD as of a date: net debit/credit per account. `balanced` must be true — use it to check the ledger before trusting the other reports.', { asOf, teamId }, READ, (args) => client.getTrialBalance(args));
    tool('get_report_pnl', 'Profit & loss', 'Profit & loss in USD for a period (default: the current calendar year): income, expenses and net result per account, built from posted journals only. Use it to answer "how much did we earn/spend"; pass department for one department, or get_pnl_by_department for all side by side. Never invent figures that are not in the report.', {
        teamId,
        from: periodFrom,
        to: periodTo,
        department: z.string().optional().describe('Department code (list_departments), or "none" for company-level lines only. Omit for the whole company.'),
    }, READ, (args) => client.getReportPnl(args));
    tool('list_departments', 'List departments', 'Departments (classes) inside the company\'s books, e.g. EGS Elania Game Studio, NH NeonHappi. Untagged = the company itself.', { teamId }, READ, (args) => client.listDepartments(args));
    tool('create_department', 'Create a department', 'Add a department (class) to the company\'s books so bank lines and journal lines can be tagged with it. Check list_departments first to avoid duplicates.', {
        code: z.string().describe('Short code used for tagging, e.g. "NH".'),
        name: z.string().describe('Full name, e.g. "NeonHappi".'),
        teamId,
    }, WRITE, (args) => client.createDepartment(args));
    tool('set_transaction_department', 'Tag a bank line with a department', 'Tag a bank line with a department (null untags); a posted line\'s journal follows. Only tag when the source says which product.', { id: txnId, departmentCode: z.string().nullable().describe('Department code from list_departments; null removes the tag.'), teamId }, WRITE_IDEMPOTENT, (args) => client.setTransactionDepartment(args.id, args));
    tool('get_pnl_by_department', 'Profit & loss by department', 'P&L per department plus company-level lines for a period (default: the current calendar year); columns add up to the company P&L.', { from: periodFrom, to: periodTo, teamId }, READ, (args) => client.getPnlByDepartment(args));
    tool('get_report_bs', 'Balance sheet', 'Balance sheet in USD as of a date: assets, liabilities and equity from posted journals. Opening may be incomplete until a 1 Jan 2025 TB is posted.', { teamId, asOf }, READ, (args) => client.getReportBs(args));
    tool('get_report_cash', 'Cash by bank pot', 'Cash per bank pot in native currency. USD (amountHome) only when every line has a rate; otherwise null with missingRateCount.', { teamId, asOf }, READ, (args) => client.getReportCash(args));
};

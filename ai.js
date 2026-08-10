// AI document extraction via the Anthropic API (set ANTHROPIC_API_KEY to enable).
// Used for: (1) reading closing docs to prefill loan terms, (2) reading bank/credit
// card statements to extract transactions for property expense assignment.

const AI_KEY = () => process.env.ANTHROPIC_API_KEY || '';
const aiEnabled = () => !!AI_KEY();
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

async function callClaude(systemPrompt, contentBlocks, maxTokens = 4000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': AI_KEY(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: contentBlocks }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : `Anthropic API error ${res.status}`);
  const text = json.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in AI response');
  return JSON.parse(match[0]);
}

function docBlock(buffer, mime) {
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  if (/^image\//.test(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } };
  }
  // treat as text (csv, txt)
  return { type: 'text', text: buffer.toString('utf8').slice(0, 150000) };
}

// Extract loan terms from closing documents.
async function extractLoanTerms(files /* [{buffer, mime, filename}] */) {
  const blocks = [];
  for (const f of files) {
    blocks.push({ type: 'text', text: `--- Document: ${f.filename} ---` });
    blocks.push(docBlock(f.buffer, f.mime));
  }
  blocks.push({
    type: 'text',
    text: 'Extract the loan/contract terms from these closing documents and respond with ONLY a JSON object.',
  });
  const system = `You are a loan servicing assistant for a real estate investor who sells homes to tenant buyers
via land contracts (contract for deed) or beneficial interest assignments in land trusts.
Extract the deal terms from the closing documents. Respond with ONLY valid JSON matching this schema
(use null for anything not found; all money amounts as numbers in DOLLARS; dates as YYYY-MM-DD):
{
  "buyer_name": string|null,
  "buyer_email": string|null,
  "buyer_phone": string|null,
  "property_address": string|null, "city": string|null, "state": string|null, "zip": string|null,
  "loan_type": "land_contract" | "land_trust_beneficial_interest" | null,
  "trust_name": string|null, "trustee": string|null, "beneficial_interest_pct": number|null,
  "sale_price": number|null,
  "down_payment": number|null,
  "amount_financed": number|null,
  "interest_rate_pct": number|null,
  "term_months": number|null,
  "monthly_payment_pi": number|null,
  "monthly_escrow": number|null,
  "late_fee": number|null,
  "grace_days": number|null,
  "first_payment_date": string|null,
  "notes": string|null
}`;
  return callClaude(system, blocks);
}

// Extract transactions from a bank or credit card statement.
async function extractTransactions(file /* {buffer, mime, filename} */, propertyList) {
  const blocks = [
    { type: 'text', text: `--- Statement: ${file.filename} ---` },
    docBlock(file.buffer, file.mime),
    {
      type: 'text',
      text: `Extract all debit/expense transactions. Known properties (for suggested matching): ${JSON.stringify(propertyList)}. Respond with ONLY JSON.`,
    },
  ];
  const system = `You extract expense transactions from bank and credit card statements for a real estate investor.
Respond with ONLY valid JSON:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": string,
      "amount": number,           // positive dollars for money spent; skip deposits/credits/payments-received
      "category": string|null,    // e.g. insurance, taxes, repairs, utilities, HOA, materials, other
      "suggested_property_id": number|null  // id from the known properties list if the transaction clearly relates to it
    }
  ]
}`;
  return callClaude(system, blocks, 8000);
}

module.exports = { aiEnabled, extractLoanTerms, extractTransactions };

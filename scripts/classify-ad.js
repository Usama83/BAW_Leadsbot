// Best-effort furniture category/product classification from ad name,
// campaign, and creative text (Arabic + English keywords).

const CATEGORIES = [
  { cat: "Bedroom", re: /bed(room|ding)?|سرير|سراير|غرف(ة)?\s*نوم|مرتب|تسريح|كمود/i },
  { cat: "Seating / Salon", re: /salon|sofa|couch|chair|armchair|كنب|صالون|كرسي|كراسي|ركن(ة|ه)|مجلس|انترية|فوتيه/i },
  { cat: "Dining", re: /dining|سفرة|طاولة\s*طعام|غرف(ة)?\s*سفرة|ترابيزة\s*سفرة|buffet\s*table/i },
  { cat: "Tables", re: /table|طاول|ترابيز|كونسول|console|نيست|متداخل/i },
  { cat: "Office", re: /office|desk|مكتب|مكاتب|executive/i },
  { cat: "Lighting", re: /lamp|light|chandelier|اباجور|أباجور|ثري(ا|ه)|نجف|إضاءة|اضاءة/i },
  { cat: "Storage / Buffet", re: /بوفيه|buffet|خزان|دولاب|نيش|cabinet|wardrobe|شوني(ة|ه)/i },
  { cat: "Mirrors & Decor", re: /mirror|مرآ|مرايا|مبخر|تحف|فازة|ديكور|decor|ساعة|اكسسوار/i },
  { cat: "Kids", re: /kids|اطفال|أطفال/i },
  { cat: "Outdoor", re: /outdoor|حديق(ة|ه)|جنينة|garden/i },
];

const NOISE_RE = /\b(video|static|creative|ig post|instagram post|منشور instagram|post|reel|story|ksa|egypt|uae|gcc|global|adv|plc|uge|sales|messages|traffic|eng|conversion|remarketing|جديد|عرض|:)\b/gi;

export function classifyAd({ name, campaign, body } = {}) {
  const hay = [name, campaign, body].filter(Boolean).join(" \n ");
  let category = "Other";
  for (const c of CATEGORIES) {
    if (c.re.test(hay)) { category = c.cat; break; }
  }
  // Product: the descriptive residue of the ad name once campaign-speak is removed.
  let product = String(name || "")
    .replace(/[|•·_]/g, " ")
    .replace(NOISE_RE, " ")
    .replace(/[\s‎‏]+/g, " ")
    .replace(/[.,:؛]+/g, " ")
    .trim();
  if (!product) product = null;
  return { category, product };
}

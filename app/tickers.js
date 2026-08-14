// ============================================================================
// A curated, static reference list of real stock/ETF/mutual-fund ticker
// symbols and crypto symbols, used to validate the ticker field on an
// Investments-tab holding - same role BANK_NAMES plays for the Bank field
// (isKnownBank), same shape of honesty required about it too.
//
// IMPORTANT LIMITATION, stated plainly: unlike BANK_NAMES (fetched from a
// real FDIC data source), there is no free, live market-data API this
// $0-constrained project can pull a verified ticker feed from. This list is
// hand-curated from training knowledge as of this file's creation
// (2026-08-12), not a live or independently verified feed - it WILL miss
// real, legitimate tickers (thousands of publicly traded securities exist;
// this covers a few hundred well-known ones), and index membership/fund
// lineups change over time in ways this file will not track. Treat it as
// "a reasonable first check," not an authority - which is exactly why
// isKnownTicker()'s caller (app.js) always offers a confirm-to-override
// path for a real ticker it doesn't recognize, the same pattern
// isKnownBank() already established. Never treat a false negative here as
// proof a ticker isn't real.
//
// Three separate sets, not one flat list, because a ticker collision across
// them is a real risk (a mutual fund symbol coinciding with an unrelated
// stock ticker is possible) and because the UI may eventually want to
// label a match by kind. STOCK_TICKERS covers large, well-known US-listed
// equities. ETF_TICKERS covers broad-market/sector/bond/thematic index
// funds (this is where "index funds" mostly live - most index EXPOSURE
// today is via an ETF wrapper, not a mutual fund one). MUTUAL_FUND_TICKERS
// covers the actual 5-letter-code mutual fund share classes (Vanguard/
// Fidelity/Schwab/American Funds/T. Rowe Price/Dodge & Cox families
// especially) - this is the other half of "index and mutual funds," since
// a fund like VFIAX (Vanguard 500 Index Fund) is an index fund in mutual-
// fund form, not ETF form. CRYPTO_SYMBOLS is separate again, deliberately -
// a crypto "ticker" (BTC, ETH) is not a market-issued security symbol the
// way a stock/ETF/fund ticker is, so it is checked against this list
// instead of the other three, only for a holding whose parent account is
// type 'crypto'.
// ============================================================================

export const STOCK_TICKERS = [
  "AAPL", "ABBV", "ABNB", "ABT", "ADBE", "AEP", "AIG", "ALL", "AMD", "AMGN",
  "AMT", "AMZN", "AON", "APD", "ATVI", "AVB", "AVGO", "AXP", "BA", "BAC",
  "BDX", "BK", "BKNG", "BLK", "BMY", "BSX", "C", "CAT", "CB", "CCI",
  "CHTR", "CI", "CL", "CMCSA", "CMG", "COF", "COIN", "COP", "COST", "CRM",
  "CRWD", "CSCO", "CVS", "CVX", "D", "DASH", "DDOG", "DE", "DG", "DHR",
  "DIS", "DLTR", "DOCU", "DUK", "EA", "EBAY", "ECL", "EL", "ELV", "EMR",
  "EOG", "EQIX", "EQR", "ETN", "ETSY", "EXC", "FCX", "FDX", "FOXA", "GD",
  "GE", "GILD", "GIS", "GOOG", "GOOGL", "GS", "HD", "HON", "HOOD", "HSY",
  "HUM", "IBM", "INTC", "INTU", "ISRG", "ITW", "JNJ", "JPM", "K", "KMB",
  "KO", "KR", "LIN", "LLY", "LMT", "LOW", "LULU", "MAR", "MCD", "MDB",
  "MDLZ", "MDT", "MET", "META", "MMC", "MMM", "MO", "MPC", "MRK", "MS",
  "MSFT", "NEE", "NEM", "NET", "NFLX", "NKE", "NOC", "NOW", "NVDA", "NWSA",
  "O", "OKTA", "ORCL", "OXY", "PANW", "PARA", "PEP", "PFE", "PG", "PGR",
  "PH", "PLD", "PLTR", "PM", "PNC", "PRU", "PSA", "PSX", "PYPL", "QCOM",
  "RBLX", "REGN", "ROST", "RTX", "SBUX", "SCHW", "SHOP", "SHW", "SLB", "SNOW",
  "SO", "SPG", "SPGI", "SQ", "STZ", "SYK", "SYY", "T", "TEAM", "TFC",
  "TGT", "TJX", "TMO", "TMUS", "TRV", "TSLA", "TTWO", "TXN", "U", "UBER",
  "UNH", "UNP", "UPS", "USB", "VLO", "VRTX", "VZ", "WBD", "WDAY", "WELL",
  "WFC", "WMT", "XEL", "XOM", "YUM", "ZM", "ZTS",
];

export const ETF_TICKERS = [
  "ACWI", "ACWX", "AGG", "ARKF", "ARKG", "ARKK", "ARKQ", "ARKW", "BITO", "BND",
  "BNDX", "DIA", "DVY", "EEM", "EFA", "FBTC", "GBTC", "GDX", "GLD", "HDV",
  "HYG", "IAU", "IBIT", "IEF", "IEMG", "IJH", "IJR", "IVV", "IWD", "IWF",
  "IWM", "LQD", "MDY", "MGK", "MGV", "MUB", "NOBL", "QQQ", "QQQM", "SCHD",
  "SCZ", "SDY", "SHY", "SLV", "SPHD", "SPY", "SPYG", "SPYV", "TIP", "TLT",
  "UNG", "USO", "VAW", "VB", "VBR", "VCIT", "VCSH", "VDC", "VDE", "VEA",
  "VFH", "VGIT", "VGSH", "VGT", "VHT", "VIG", "VIS", "VNQ", "VO", "VOE",
  "VONG", "VONV", "VOO", "VOX", "VPU", "VSS", "VT", "VTI", "VTV", "VTWO",
  "VUG", "VWO", "VXUS", "VYM", "XLB", "XLC", "XLE", "XLF", "XLI", "XLK",
  "XLP", "XLRE", "XLU", "XLV", "XLY",
];

export const MUTUAL_FUND_TICKERS = [
  "AEPGX", "AGTHX", "AIVSX", "AMCPX", "ANCFX", "AWSHX", "CWGIX", "DODBX", "DODFX", "DODGX",
  "FBALX", "FBGRX", "FCNTX", "FDEWX", "FDGRX", "FDVV", "FFFHX", "FLPSX", "FMAGX", "FPURX",
  "FSKAX", "FSMAX", "FSSNX", "FTIHX", "FXAIX", "FXNAX", "FZILX", "FZROX", "OAKMX", "PARNX",
  "PRGFX", "PRWCX", "SWAGX", "SWISX", "SWLGX", "SWMCX", "SWPPX", "SWSSX", "SWTSX", "TRBCX",
  "VBTLX", "VDIGX", "VEXAX", "VFFVX", "VFIAX", "VFIFX", "VFORX", "VGENX", "VGHCX", "VGSLX",
  "VGSTX", "VIGAX", "VPMAX", "VSMAX", "VTHRX", "VTIAX", "VTIVX", "VTSAX", "VTWAX", "VVIAX",
  "VWELX", "VWENX", "VWINX",
];

export const CRYPTO_SYMBOLS = [
  "AAVE", "ADA", "ALGO", "APE", "APT", "ARB", "ATOM", "AVAX", "BCH", "BNB",
  "BTC", "DOGE", "DOT", "EOS", "ETC", "ETH", "FIL", "GRT", "LINK", "LTC",
  "MANA", "MATIC", "MKR", "NEAR", "OP", "SAND", "SHIB", "SOL", "TRX", "UNI",
  "USDC", "USDT", "VET", "XLM", "XMR", "XRP",
];


// All non-crypto tickers combined, for a single "is this a known
// stock/ETF/fund symbol" check - callers that want to know WHICH kind
// matched (not needed by isKnownTicker() itself today) can check the three
// exported arrays directly instead.
export const ALL_SECURITY_TICKERS = [
  ...STOCK_TICKERS, ...ETF_TICKERS, ...MUTUAL_FUND_TICKERS,
];

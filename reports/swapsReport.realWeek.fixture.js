// /api/SwapsReport for 2026-09-05..2026-09-11 (liveFinalto=false), pulled live
// from the logged-in dashboard on 2026-09-17. It is the regression fixture for
// the "a missing statement is not null" bug, so the LP half is kept VERBATIM:
//
//   - every one of the 43 LPs carries statementSwap: 0 AND statementRowCount: 0.
//     No LP had a statement uploaded for that week. The backend does not send
//     null for a missing statement; it sends a zero with no rows behind it.
//   - AIDI and Broctagon2 failed with an IPC timeout and are absent from lps[]
//     entirely; only lpErrors says they exist.
//   - the 43 LP totalSwap figures sum to -48,265.24, exactly the backend's own
//     lpTotals.totalSwap, so no LP row was lost in extraction.
//
// Treating that zero as a statement made every Manager LP a confident $0.00 and
// printed an LP total of -27,767.27: the Terminal and Api LPs only, with all 27
// Manager LPs (-20,497.97 of MT5 swap) silently left out.
//
// The CLIENT rows are not verbatim. Their swap figures are the real ones, but
// the names and logins are synthetic: real client names do not belong in the
// repository, and nothing under test depends on who the clients are.
const L = (id, lpName, login, source, apiVendor, totalSwap, unrealizedSwap, statementSwap, statementRowCount, dealVolume, realizedVolume) =>
  ({ id, lpName, login, source, apiVendor, totalSwap, unrealizedSwap, statementSwap, statementRowCount, dealVolume, realizedVolume });
const C = (login, name, totalSwap, unrealizedSwap, dealVolume, realizedVolume) =>
  ({ login, name, totalSwap, unrealizedSwap, dealVolume, realizedVolume });

export const REAL_WEEK = {
  fromUnixSec: 1788566400,
  toUnixSec: 1789171199,
  clientTotals: { totalSwap: -21309, unrealizedSwap: -7854.45, accountCount: 22 },
  lpTotals: { totalSwap: -48265.24, unrealizedSwap: -333179.1, accountCount: 43 },
  skippedApiLpCount: 0,
  lpErrors: [
    "AIDI (56720794): Deals worker error for LP AIDI: Connection failed for login 56720794. Error: (-10005, 'IPC timeout')",
    "Broctagon2 (101824): Deals worker error for LP Broctagon2: Connection failed for login 101824. Error: (-10005, 'IPC timeout')",
  ],
  clientPanelError: null,
  lps: [
    L(39,"IG Coverage",101971,"Manager",null,0,-298765.41,0,0,0,0),
    L(22,"FXCM 2 Coverage",101172,"Manager",null,-3813.72,-13137.94,0,0,0,0),
    L(32,"Amana 1",8007388,"Terminal",null,-12277.45,0,0,0,0,0),
    L(14,"FX Edge Coverage ",101095,"Manager",null,-11059.16,-1751.81,0,0,0,0),
    L(51,"Scope Prime",80132,"Terminal",null,-9883.71,0,0,0,0,0),
    L(30,"Finalto 2nd acc 33758 - Coverage",101860,"Manager",null,-3840,-8559.88,0,0,0,0),
    L(47,"XTB Direct API",3297149,"Api","Xtb",-2122.34,-4634.32,0,0,0,0),
    L(35,"XTB Bonus 1(Coverage)",101927,"Manager",null,0,-3623.15,0,0,0,0),
    L(45,"Infinox",87037247,"Terminal",null,-3358.94,0,0,0,0,0),
    L(15,"Finalto Coverage 33931 REV",100915,"Manager",null,0,-2572.51,0,0,0,0),
    L(44,"EdgeWaterMark Coverage ACC",102083,"Manager",null,-2542.51,-818.46,0,0,0,0),
    L(27,"LMAX 2nd ACC TOB1 OmnibusAc",101753,"Manager",null,762.32,680.84,0,0,0,0),
    L(52,"Finalto API",0,"Api","Finalto",-84.61,0,0,0,0,0),
    L(8,"Noor Capital",5400231,"Terminal",null,-33.75,0,0,0,0,0),
    L(13,"CFI",19010008,"Terminal",null,-6.47,0,0,0,0,0),
    L(41,"B2B 2Nd acc",101984,"Manager",null,-4.9,2.38,0,0,0,0),
    L(37,"Finalto 3rd account coverage 34899",101934,"Manager",null,0,1.16,0,0,0,0),
    L(34,"XOH 1stAcc Coverage",101920,"Manager",null,0,0,0,0,0,0),
    L(9,"ICM",5101163,"Terminal",null,0,0,0,0,0,0),
    L(3,"Broctagon1",101823,"Terminal",null,0,0,0,0,0,0),
    L(11,"LP Prime",10054,"Terminal",null,0,0,0,0,0,0),
    L(2,"Amana2",8008598,"Terminal",null,0,0,0,0,0,0),
    L(10,"Multi Bank",810597,"Terminal",null,0,0,0,0,0,0),
    L(54,"StarPrime2 - MT5",5033,"Terminal",null,0,0,0,0,0,0),
    L(12,"Hantec",50120073,"Terminal",null,0,0,0,0,0,0),
    L(49,"Velocity",102177,"Manager",null,0,0,0,0,0,0),
    L(36,"Lmax 3rd acc  TOB5",101932,"Manager",null,0,0,0,0,0,0),
    L(40,"LP-101977",101977,"Manager",null,0,0,0,0,0,0),
    L(46,"Lmax Perpetual Coverage",102114,"Manager",null,0,0,0,0,0,0),
    L(19,"LMAX Old",101096,"Manager",null,0,0,0,0,0,0),
    L(7,"Taurex",120008722,"Terminal",null,0,0,0,0,0,0),
    L(20,"LMAX",101445,"Manager",null,0,0,0,0,0,0),
    L(43,"IRESS COVERAGE acc",102037,"Manager",null,0,0,0,0,0,0),
    L(21,"FXCM Coverage",101125,"Manager",null,0,0,0,0,0,0),
    L(24,"EQUITY Revenue",101397,"Manager",null,0,0,0,0,0,0),
    L(48,"EdgeWaterMark Coverage 2ndACC",102128,"Manager",null,0,0,0,0,0,0),
    L(29,"Coverage XopenHub2nd Acc",101797,"Manager",null,0,0,0,0,0,0),
    L(18,"CMC Coverage",101059,"Manager",null,0,0,0,0,0,0),
    L(23,"CMC 2 Coverage",101310,"Manager",null,0,0,0,0,0,0),
    L(25,"B2B Coverage account",101487,"Manager",null,0,0,0,0,0,0),
    L(26,"ATFX 2 coverage acc #186",101691,"Manager",null,0,0,0,0,0,0),
    L(42,"TopFX",102007,"Manager",null,0,0,0,0,0,0),
    L(33,"Taurex2",120029047,"Terminal",null,0,0,0,0,0,0),
  ],
  clients: [
    C(900001,"Synthetic Client 01",-11457.96,415.86,0,0),
    C(900002,"Synthetic Client 02",-5036.23,-6094.12,0,0),
    C(900003,"Synthetic Client 03",-1332.35,-1874.72,0,0),
    C(900004,"Synthetic Client 04",-1148.57,0,0,0),
    C(900005,"Synthetic Client 05",-890.41,0,0,0),
    C(900006,"Synthetic Client 06",-772.94,-75.52,0,0),
    C(900007,"Synthetic Client 07",117.47,746.92,0,0),
    C(900008,"Synthetic Client 08",0,-378.78,0,0),
    C(900009,"Synthetic Client 09",-341.36,0,0,0),
    C(900010,"Synthetic Client 10",19.03,-281.28,0,0),
    C(900011,"Synthetic Client 11",7.87,-208.73,0,0),
    C(900012,"Synthetic Client 12",-115.7,0,0,0),
    C(900013,"Synthetic Client 13",-115.7,0,0,0),
    C(900014,"Synthetic Client 14",-115.7,0,0,0),
    C(900015,"Synthetic Client 15",0,-79.6,0,0),
    C(900016,"Synthetic Client 16",-70.12,0,0,0),
    C(900017,"Synthetic Client 17",-58.72,0,0,0),
    C(900018,"Synthetic Client 18",18.64,27.01,0,0),
    C(900019,"Synthetic Client 19",0,-25.2,0,0),
    C(900020,"Synthetic Client 20",-7.02,-21.05,0,0),
    C(900021,"Synthetic Client 21",-9.23,0,0,0),
    C(900022,"Synthetic Client 22",0,-5.24,0,0),
  ],
};

/**
 * Glyph names for simple fonts: the three Latin base encodings (ISO 32000-1
 * Annex D) and the Adobe Glyph List entries they and Latin, Greek, Cyrillic
 * and common symbol text use. Generated from pdf.js' tables.
 */

const decodeEncoding = (s: string): string[] => [
  ...new Array<string>(32).fill(""),
  ...s.split(" ").map((n) => (n === "." ? "" : n)),
];

/** Codes 0-255 to glyph names ("" = no glyph). */
export const STANDARD_ENCODING = decodeEncoding(
  "space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl . endash dagger daggerdbl periodcentered . paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand . questiondown . grave acute circumflex tilde macron breve dotaccent dieresis . ring cedilla . hungarumlaut ogonek caron emdash . . . . . . . . . . . . . . . . AE . ordfeminine . . . . Lslash Oslash OE ordmasculine . . . . . ae . . . dotlessi . . lslash oslash oe germandbls . . . .",
);
export const WINANSI_ENCODING = decodeEncoding(
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde . Euro . quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE . Zcaron . . quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe . zcaron Ydieresis space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis",
);
export const MACROMAN_ENCODING = decodeEncoding(
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde . Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron",
);

// name:hex pairs, space-separated.
const AGL_DATA =
  "A:41 AE:c6 AEacute:1fc AEmacron:1e2 Aacute:c1 Abreve:102 Abrevecyrillic:4d0 Acaron:1cd Acircumflex:c2" +
  " Acyrillic:410 Adblgrave:200 Adieresis:c4 Adieresiscyrillic:4d2 Adieresismacron:1de Adotmacron:1e0 Agrave:c0" +
  " Aiecyrillic:4d4 Ainvertedbreve:202 Alpha:391 Alphatonos:386 Amacron:100 Aogonek:104 Aring:c5 Aringacute:1fa" +
  " Atilde:c3 B:42 Becyrillic:411 Beta:392 Bhook:181 Btopbar:182 C:43 Cacute:106 Ccaron:10c Ccedilla:c7" +
  " Ccircumflex:108 Cdot:10a Cdotaccent:10a Cheabkhasiancyrillic:4bc Checyrillic:427 Chedescenderabkhasiancyrillic:4be" +
  " Chedescendercyrillic:4b6 Chedieresiscyrillic:4f4 Chekhakassiancyrillic:4cb Cheverticalstrokecyrillic:4b8" +
  " Chi:3a7 Chook:187 D:44 DZ:1f1 DZcaron:1c4 Dafrican:189 Dcaron:10e Dcroat:110 Decyrillic:414 Deicoptic:3ee" +
  " Delta:2206 Deltagreek:394 Dhook:18a Digammagreek:3dc Djecyrillic:402 Dslash:110 Dtopbar:18b Dz:1f2 Dzcaron:1c5" +
  " Dzeabkhasiancyrillic:4e0 Dzecyrillic:405 Dzhecyrillic:40f E:45 Eacute:c9 Ebreve:114 Ecaron:11a Ecircumflex:ca" +
  " Ecyrillic:404 Edblgrave:204 Edieresis:cb Edot:116 Edotaccent:116 Efcyrillic:424 Egrave:c8 Einvertedbreve:206" +
  " Eiotifiedcyrillic:464 Elcyrillic:41b Emacron:112 Emcyrillic:41c Encyrillic:41d Endescendercyrillic:4a2" +
  " Eng:14a Enghecyrillic:4a4 Enhookcyrillic:4c7 Eogonek:118 Eopen:190 Epsilon:395 Epsilontonos:388 Ercyrillic:420" +
  " Ereversed:18e Ereversedcyrillic:42d Escyrillic:421 Esdescendercyrillic:4aa Esh:1a9 Eta:397 Etatonos:389" +
  " Eth:d0 Euro:20ac Ezh:1b7 Ezhcaron:1ee Ezhreversed:1b8 F:46 Feicoptic:3e4 Fhook:191 Fitacyrillic:472" +
  " G:47 Gacute:1f4 Gamma:393 Gammaafrican:194 Gangiacoptic:3ea Gbreve:11e Gcaron:1e6 Gcedilla:122 Gcircumflex:11c" +
  " Gcommaaccent:122 Gdot:120 Gdotaccent:120 Gecyrillic:413 Ghemiddlehookcyrillic:494 Ghestrokecyrillic:492" +
  " Gheupturncyrillic:490 Ghook:193 Gjecyrillic:403 Gstroke:1e4 H:48 Haabkhasiancyrillic:4a8 Hadescendercyrillic:4b2" +
  " Hardsigncyrillic:42a Hbar:126 Hcircumflex:124 Horicoptic:3e8 I:49 IAcyrillic:42f IJ:132 IUcyrillic:42e" +
  " Iacute:cd Ibreve:12c Icaron:1cf Icircumflex:ce Icyrillic:406 Idblgrave:208 Idieresis:cf Idieresiscyrillic:4e4" +
  " Idot:130 Idotaccent:130 Iebrevecyrillic:4d6 Iecyrillic:415 Ifraktur:2111 Igrave:cc Iicyrillic:418 Iinvertedbreve:20a" +
  " Iishortcyrillic:419 Imacron:12a Imacroncyrillic:4e2 Iocyrillic:401 Iogonek:12e Iota:399 Iotaafrican:196" +
  " Iotadieresis:3aa Iotatonos:38a Istroke:197 Itilde:128 Izhitsacyrillic:474 Izhitsadblgravecyrillic:476" +
  " J:4a Jcircumflex:134 Jecyrillic:408 K:4b Kabashkircyrillic:4a0 Kacyrillic:41a Kadescendercyrillic:49a" +
  " Kahookcyrillic:4c3 Kappa:39a Kastrokecyrillic:49e Kaverticalstrokecyrillic:49c Kcaron:1e8 Kcedilla:136" +
  " Kcommaaccent:136 Khacyrillic:425 Kheicoptic:3e6 Khook:198 Kjecyrillic:40c Koppacyrillic:480 Koppagreek:3de" +
  " Ksicyrillic:46e L:4c LJ:1c7 Lacute:139 Lambda:39b Lcaron:13d Lcedilla:13b Lcommaaccent:13b Ldot:13f" +
  " Ldotaccent:13f Lj:1c8 Ljecyrillic:409 Lslash:141 M:4d Mturned:19c Mu:39c N:4e NJ:1ca Nacute:143 Ncaron:147" +
  " Ncedilla:145 Ncommaaccent:145 Nhookleft:19d Nj:1cb Njecyrillic:40a Ntilde:d1 Nu:39d O:4f OE:152 Oacute:d3" +
  " Obarredcyrillic:4e8 Obarreddieresiscyrillic:4ea Obreve:14e Ocaron:1d1 Ocenteredtilde:19f Ocircumflex:d4" +
  " Ocyrillic:41e Odblacute:150 Odblgrave:20c Odieresis:d6 Odieresiscyrillic:4e6 Ograve:d2 Ohm:2126 Ohorn:1a0" +
  " Ohungarumlaut:150 Oi:1a2 Oinvertedbreve:20e Omacron:14c Omega:2126 Omegacyrillic:460 Omegagreek:3a9" +
  " Omegaroundcyrillic:47a Omegatitlocyrillic:47c Omegatonos:38f Omicron:39f Omicrontonos:38c Oogonek:1ea" +
  " Oogonekmacron:1ec Oopen:186 Oslash:d8 Oslashacute:1fe Ostrokeacute:1fe Otcyrillic:47e Otilde:d5 P:50" +
  " Pecyrillic:41f Pemiddlehookcyrillic:4a6 Phi:3a6 Phook:1a4 Pi:3a0 Psi:3a8 Psicyrillic:470 Q:51 R:52 Racute:154" +
  " Rcaron:158 Rcedilla:156 Rcommaaccent:156 Rdblgrave:210 Rfraktur:211c Rho:3a1 Rinvertedbreve:212 S:53" +
  " Sacute:15a Sampigreek:3e0 Scaron:160 Scedilla:15e Schwa:18f Schwacyrillic:4d8 Schwadieresiscyrillic:4da" +
  " Scircumflex:15c Scommaaccent:218 Shacyrillic:428 Shchacyrillic:429 Sheicoptic:3e2 Shhacyrillic:4ba Shimacoptic:3ec" +
  " Sigma:3a3 Softsigncyrillic:42c Stigmagreek:3da T:54 Tau:3a4 Tbar:166 Tcaron:164 Tcedilla:162 Tcommaaccent:162" +
  " Tecyrillic:422 Tedescendercyrillic:4ac Tetsecyrillic:4b4 Theta:398 Thook:1ac Thorn:de Tonefive:1bc Tonesix:184" +
  " Tonetwo:1a7 Tretroflexhook:1ae Tsecyrillic:426 Tshecyrillic:40b U:55 Uacute:da Ubreve:16c Ucaron:1d3" +
  " Ucircumflex:db Ucyrillic:423 Udblacute:170 Udblgrave:214 Udieresis:dc Udieresisacute:1d7 Udieresiscaron:1d9" +
  " Udieresiscyrillic:4f0 Udieresisgrave:1db Udieresismacron:1d5 Ugrave:d9 Uhorn:1af Uhungarumlaut:170 Uhungarumlautcyrillic:4f2" +
  " Uinvertedbreve:216 Ukcyrillic:478 Umacron:16a Umacroncyrillic:4ee Uogonek:172 Upsilon:3a5 Upsilon1:3d2" +
  " Upsilonacutehooksymbolgreek:3d3 Upsilonafrican:1b1 Upsilondieresis:3ab Upsilondieresishooksymbolgreek:3d4" +
  " Upsilonhooksymbol:3d2 Upsilontonos:38e Uring:16e Ushortcyrillic:40e Ustraightcyrillic:4ae Ustraightstrokecyrillic:4b0" +
  " Utilde:168 V:56 Vecyrillic:412 Vhook:1b2 W:57 Wcircumflex:174 X:58 Xi:39e Y:59 Yacute:dd Yatcyrillic:462" +
  " Ycircumflex:176 Ydieresis:178 Yericyrillic:42b Yerudieresiscyrillic:4f8 Yhook:1b3 Yicyrillic:407 Yusbigcyrillic:46a" +
  " Yusbigiotifiedcyrillic:46c Yuslittlecyrillic:466 Yuslittleiotifiedcyrillic:468 Z:5a Zacute:179 Zcaron:17d" +
  " Zdot:17b Zdotaccent:17b Zecyrillic:417 Zedescendercyrillic:498 Zedieresiscyrillic:4de Zeta:396 Zhebrevecyrillic:4c1" +
  " Zhecyrillic:416 Zhedescendercyrillic:496 Zhedieresiscyrillic:4dc Zstroke:1b5 a:61 aacute:e1 abreve:103" +
  " abrevecyrillic:4d1 acaron:1ce acircumflex:e2 acute:b4 acutelowmod:2cf acyrillic:430 adblgrave:201 adieresis:e4" +
  " adieresiscyrillic:4d3 adieresismacron:1df adotmacron:1e1 ae:e6 aeacute:1fd aemacron:1e3 afii00208:2015" +
  " afii08941:20a4 afii10017:410 afii10018:411 afii10019:412 afii10020:413 afii10021:414 afii10022:415 afii10023:401" +
  " afii10024:416 afii10025:417 afii10026:418 afii10027:419 afii10028:41a afii10029:41b afii10030:41c afii10031:41d" +
  " afii10032:41e afii10033:41f afii10034:420 afii10035:421 afii10036:422 afii10037:423 afii10038:424 afii10039:425" +
  " afii10040:426 afii10041:427 afii10042:428 afii10043:429 afii10044:42a afii10045:42b afii10046:42c afii10047:42d" +
  " afii10048:42e afii10049:42f afii10050:490 afii10051:402 afii10052:403 afii10053:404 afii10054:405 afii10055:406" +
  " afii10056:407 afii10057:408 afii10058:409 afii10059:40a afii10060:40b afii10061:40c afii10062:40e afii10065:430" +
  " afii10066:431 afii10067:432 afii10068:433 afii10069:434 afii10070:435 afii10071:451 afii10072:436 afii10073:437" +
  " afii10074:438 afii10075:439 afii10076:43a afii10077:43b afii10078:43c afii10079:43d afii10080:43e afii10081:43f" +
  " afii10082:440 afii10083:441 afii10084:442 afii10085:443 afii10086:444 afii10087:445 afii10088:446 afii10089:447" +
  " afii10090:448 afii10091:449 afii10092:44a afii10093:44b afii10094:44c afii10095:44d afii10096:44e afii10097:44f" +
  " afii10098:491 afii10099:452 afii10100:453 afii10101:454 afii10102:455 afii10103:456 afii10104:457 afii10105:458" +
  " afii10106:459 afii10107:45a afii10108:45b afii10109:45c afii10110:45e afii10145:40f afii10146:462 afii10147:472" +
  " afii10148:474 afii10193:45f afii10194:463 afii10195:473 afii10196:475 afii10846:4d9 afii299:200e afii300:200f" +
  " afii301:200d afii57636:20aa afii61248:2105 afii61289:2113 afii61352:2116 afii61573:202c afii61574:202d" +
  " afii61575:202e afii61664:200c agrave:e0 aiecyrillic:4d5 ainvertedbreve:203 aleph:2135 allequal:224c" +
  " alpha:3b1 alphatonos:3ac amacron:101 ampersand:26 angle:2220 angstrom:212b anoteleia:387 aogonek:105" +
  " apple:f8ff approaches:2250 approxequal:2248 approxequalorimage:2252 approximatelyequal:2245 aring:e5" +
  " aringacute:1fb arrowboth:2194 arrowdown:2193 arrowdownleft:2199 arrowdownright:2198 arrowleft:2190 arrowright:2192" +
  " arrowup:2191 arrowupdn:2195 arrowupleft:2196 arrowupright:2197 asciicircum:5e asciitilde:7e asterisk:2a" +
  " asteriskmath:2217 asterism:2042 asymptoticallyequal:2243 at:40 atilde:e3 b:62 backslash:5c bar:7c because:2235" +
  " becyrillic:431 beta:3b2 betasymbolgreek:3d0 braceleft:7b braceright:7d bracketleft:5b bracketright:5d" +
  " breve:2d8 brokenbar:a6 bstroke:180 btopbar:183 bullet:2022 bulletoperator:2219 c:63 cacute:107 careof:2105" +
  " caron:2c7 ccaron:10d ccedilla:e7 ccircumflex:109 cdot:10b cdotaccent:10b cedilla:b8 cent:a2 centigrade:2103" +
  " cheabkhasiancyrillic:4bd checyrillic:447 chedescenderabkhasiancyrillic:4bf chedescendercyrillic:4b7" +
  " chedieresiscyrillic:4f5 chekhakassiancyrillic:4cc cheverticalstrokecyrillic:4b9 chi:3c7 chook:188 circlecopyrt:a9" +
  " circumflex:2c6 clickalveolar:1c2 clickdental:1c0 clicklateral:1c1 clickretroflex:1c3 colon:3a colonmonetary:20a1" +
  " colonsign:20a1 colontriangularhalfmod:2d1 colontriangularmod:2d0 comma:2c congruent:2245 contourintegral:222e" +
  " controlDEL:7f copyright:a9 cruzeiro:20a2 currency:a4 d:64 dagger:2020 daggerdbl:2021 dasiapneumatacyrilliccmb:485" +
  " dblintegral:222c dbllowline:2017 dblverticalbar:2016 dcaron:10f dcroat:111 decyrillic:434 degree:b0" +
  " deicoptic:3ef delta:3b4 deltaturned:18d dialytikatonos:385 dieresis:a8 dieresistonos:385 divide:f7 divides:2223" +
  " divisionslash:2215 djecyrillic:452 dmacron:111 dollar:24 dong:20ab dotaccent:2d9 dotlessi:131 downtackmod:2d5" +
  " dtopbar:18c dz:1f3 dzcaron:1c6 dzeabkhasiancyrillic:4e1 dzecyrillic:455 dzhecyrillic:45f e:65 eacute:e9" +
  " ebreve:115 ecaron:11b ecircumflex:ea ecyrillic:454 edblgrave:205 edieresis:eb edot:117 edotaccent:117" +
  " efcyrillic:444 egrave:e8 eight:38 einvertedbreve:207 eiotifiedcyrillic:465 elcyrillic:43b element:2208" +
  " ellipsis:2026 emacron:113 emcyrillic:43c emdash:2014 emptyset:2205 encyrillic:43d endash:2013 endescendercyrillic:4a3" +
  " eng:14b enghecyrillic:4a5 enhookcyrillic:4c8 enspace:2002 eogonek:119 epsilon:3b5 epsilontonos:3ad equal:3d" +
  " equivalence:2261 ercyrillic:440 ereversedcyrillic:44d escyrillic:441 esdescendercyrillic:4ab eshreversedloop:1aa" +
  " estimated:212e eta:3b7 etatonos:3ae eth:f0 eturned:1dd euro:20ac exclam:21 exclamdbl:203c exclamdown:a1" +
  " existential:2203 ezhcaron:1ef ezhreversed:1b9 ezhtail:1ba f:66 fahrenheit:2109 feicoptic:3e5 ff:fb00" +
  " f_f:fb00 ffi:fb03 f_f_i:fb03 ffl:fb04 f_f_l:fb04 fi:fb01 f_i:fb01 figuredash:2012 firsttonechinese:2c9" +
  " fitacyrillic:473 five:35 fl:fb02 f_l:fb02 florin:192 forall:2200 four:34 fourthtonechinese:2cb fraction:2044" +
  " franc:20a3 g:67 gacute:1f5 gamma:3b3 gangiacoptic:3eb gbreve:11f gcaron:1e7 gcedilla:123 gcircumflex:11d" +
  " gcommaaccent:123 gdot:121 gdotaccent:121 gecyrillic:433 geometricallyequal:2251 germandbls:df ghemiddlehookcyrillic:495" +
  " ghestrokecyrillic:493 gheupturncyrillic:491 gjecyrillic:453 glottalinvertedstroke:1be gradient:2207" +
  " grave:60 gravelowmod:2ce greater:3e greaterequal:2265 gstroke:1e5 guillemotleft:ab guillemotright:bb" +
  " guilsinglleft:2039 guilsinglright:203a h:68 haabkhasiancyrillic:4a9 hadescendercyrillic:4b3 hardsigncyrillic:44a" +
  " hbar:127 hcircumflex:125 horicoptic:3e9 horizontalbar:2015 hungarumlaut:2dd hv:195 hyphen:2d hyphentwo:2010" +
  " i:69 iacute:ed iacyrillic:44f ibreve:12d icaron:1d0 icircumflex:ee icyrillic:456 idblgrave:209 idieresis:ef" +
  " idieresiscyrillic:4e5 iebrevecyrillic:4d7 iecyrillic:435 igrave:ec iicyrillic:438 iinvertedbreve:20b" +
  " iishortcyrillic:439 ij:133 ilde:2dc imacron:12b imacroncyrillic:4e3 imageorapproximatelyequal:2253 increment:2206" +
  " infinity:221e integral:222b intersection:2229 iocyrillic:451 iogonek:12f iota:3b9 iotadieresis:3ca iotadieresistonos:390" +
  " iotatonos:3af itilde:129 iucyrillic:44e izhitsacyrillic:475 izhitsadblgravecyrillic:477 j:6a jcaron:1f0" +
  " jcircumflex:135 jecyrillic:458 k:6b kabashkircyrillic:4a1 kacyrillic:43a kadescendercyrillic:49b kahookcyrillic:4c4" +
  " kappa:3ba kappasymbolgreek:3f0 kastrokecyrillic:49f kaverticalstrokecyrillic:49d kcaron:1e9 kcedilla:137" +
  " kcommaaccent:137 kgreenlandic:138 khacyrillic:445 kheicoptic:3e7 khook:199 kjecyrillic:45c koppacyrillic:481" +
  " ksicyrillic:46f l:6c lacute:13a lambda:3bb lambdastroke:19b lbar:19a lcaron:13e lcedilla:13c lcommaaccent:13c" +
  " ldot:140 ldotaccent:140 less:3c lessequal:2264 lira:20a4 lj:1c9 ljecyrillic:459 logicaland:2227 logicalnot:ac" +
  " logicalor:2228 longs:17f lozenge:25ca lslash:142 lsquare:2113 m:6d macron:af macronlowmod:2cd middot:b7" +
  " minus:2212 minusmod:2d7 minusplus:2213 minute:2032 mu:b5 mu1:b5 mugreek:3bc multiply:d7 n:6e nabla:2207" +
  " nacute:144 napostrophe:149 nbspace:a0 ncaron:148 ncedilla:146 ncommaaccent:146 newsheqelsign:20aa nine:39" +
  " nj:1cc njecyrillic:45a nlegrightlong:19e nonbreakingspace:a0 notcontains:220c notelement:2209 notelementof:2209" +
  " notequal:2260 notidentical:2262 notparallel:2226 ntilde:f1 nu:3bd numbersign:23 numeralsigngreek:374" +
  " numeralsignlowergreek:375 numero:2116 o:6f oacute:f3 obarredcyrillic:4e9 obarreddieresiscyrillic:4eb" +
  " obreve:14f ocaron:1d2 ocircumflex:f4 ocyrillic:43e odblacute:151 odblgrave:20d odieresis:f6 odieresiscyrillic:4e7" +
  " oe:153 ogonek:2db ograve:f2 ohorn:1a1 ohungarumlaut:151 oi:1a3 oinvertedbreve:20f omacron:14d omega:3c9" +
  " omega1:3d6 omegacyrillic:461 omegaroundcyrillic:47b omegatitlocyrillic:47d omegatonos:3ce omicron:3bf" +
  " omicrontonos:3cc one:31 onedotenleader:2024 onehalf:bd onequarter:bc onesuperior:b9 oogonek:1eb oogonekmacron:1ed" +
  " ordfeminine:aa ordmasculine:ba orthogonal:221f oslash:f8 oslashacute:1ff ostrokeacute:1ff otcyrillic:47f" +
  " otilde:f5 overline:203e overscore:af p:70 palatalizationcyrilliccmb:484 palochkacyrillic:4c0 paragraph:b6" +
  " parallel:2225 parenleft:28 parenright:29 partialdiff:2202 pecyrillic:43f pemiddlehookcyrillic:4a7 percent:25" +
  " period:2e periodcentered:b7 perthousand:2030 peseta:20a7 phi:3c6 phi1:3d5 phisymbolgreek:3d5 phook:1a5" +
  " pi:3c0 pisymbolgreek:3d6 planckover2pi:210f planckover2pi1:210f plus:2b plusminus:b1 plusmod:2d6 prescription:211e" +
  " primereversed:2035 product:220f proportion:2237 proportional:221d psi:3c8 psicyrillic:471 psilipneumatacyrilliccmb:486" +
  " q:71 question:3f questiondown:bf questiongreek:37e quotedbl:22 quotedblbase:201e quotedblleft:201c quotedblright:201d" +
  " quoteleft:2018 quoteleftreversed:201b quotereversed:201b quoteright:2019 quoterightn:149 quotesinglbase:201a" +
  " quotesingle:27 r:72 racute:155 radical:221a ratio:2236 rcaron:159 rcedilla:157 rcommaaccent:157 rdblgrave:211" +
  " referencemark:203b registered:ae reversedtilde:223d rho:3c1 rhosymbolgreek:3f1 rightangle:221f ring:2da" +
  " ringhalfleftcentered:2d3 ringhalfrightcentered:2d2 rinvertedbreve:213 s:73 sacute:15b scaron:161 scedilla:15f" +
  " schwacyrillic:4d9 schwadieresiscyrillic:4db scircumflex:15d scommaaccent:219 second:2033 secondtonechinese:2ca" +
  " section:a7 semicolon:3b seven:37 sfthyphen:ad shacyrillic:448 shchacyrillic:449 sheicoptic:3e3 sheqel:20aa" +
  " sheqelhebrew:20aa shhacyrillic:4bb shimacoptic:3ed sigma:3c3 sigma1:3c2 sigmafinal:3c2 sigmalunatesymbolgreek:3f2" +
  " similar:223c six:36 slash:2f slong:17f softhyphen:ad softsigncyrillic:44c space:20 spacehackarabic:20" +
  " sterling:a3 suchthat:220b summation:2211 t:74 tau:3c4 tbar:167 tcaron:165 tcedilla:163 tcommaaccent:163" +
  " tecyrillic:442 tedescendercyrillic:4ad telephone:2121 tetsecyrillic:4b5 thereexists:2203 therefore:2234" +
  " theta:3b8 theta1:3d1 thetasymbolgreek:3d1 thook:1ad thorn:fe thousandcyrillic:482 three:33 threequarters:be" +
  " threesuperior:b3 tilde:2dc tildeoperator:223c titlocyrilliccmb:483 tonefive:1bd tonesix:185 tonetwo:1a8" +
  " tonos:384 tpalatalhook:1ab trademark:2122 tsecyrillic:446 tshecyrillic:45b two:32 twodotenleader:2025" +
  " twodotleader:2025 twostroke:1bb twosuperior:b2 u:75 uacute:fa ubreve:16d ucaron:1d4 ucircumflex:fb ucyrillic:443" +
  " udblacute:171 udblgrave:215 udieresis:fc udieresisacute:1d8 udieresiscaron:1da udieresiscyrillic:4f1" +
  " udieresisgrave:1dc udieresismacron:1d6 ugrave:f9 uhorn:1b0 uhungarumlaut:171 uhungarumlautcyrillic:4f3" +
  " uinvertedbreve:217 ukcyrillic:479 umacron:16b umacroncyrillic:4ef underscore:5f underscoredbl:2017 union:222a" +
  " universal:2200 uogonek:173 upsilon:3c5 upsilondieresis:3cb upsilondieresistonos:3b0 upsilontonos:3cd" +
  " uptackmod:2d4 uring:16f ushortcyrillic:45e ustraightcyrillic:4af ustraightstrokecyrillic:4b1 utilde:169" +
  " v:76 vecyrillic:432 verticalbar:7c verticallinelowmod:2cc verticallinemod:2c8 w:77 wcircumflex:175 weierstrass:2118" +
  " won:20a9 wynn:1bf x:78 xi:3be y:79 yacute:fd yatcyrillic:463 ycircumflex:177 ydieresis:ff yen:a5 yericyrillic:44b" +
  " yerudieresiscyrillic:4f9 yhook:1b4 yicyrillic:457 yotgreek:3f3 ypogegrammeni:37a yr:1a6 yusbigcyrillic:46b" +
  " yusbigiotifiedcyrillic:46d yuslittlecyrillic:467 yuslittleiotifiedcyrillic:469 z:7a zacute:17a zcaron:17e" +
  " zdot:17c zdotaccent:17c zecyrillic:437 zedescendercyrillic:499 zedieresiscyrillic:4df zero:30 zerowidthnonjoiner:200c" +
  " zerowidthspace:200b zeta:3b6 zhebrevecyrillic:4c2 zhecyrillic:436 zhedescendercyrillic:497 zhedieresiscyrillic:4dd" +
  " zstroke:1b6 arrownortheast:2197 arrownorthwest:2196 arrowsoutheast:2198 arrowsouthwest:2199 backslashbig:2216" +
  " backslashBig:2216 backslashBigg:2216 backslashbigg:2216 bardbl:2016 braceleftBig:7b braceleftbig:7b" +
  " braceleftbigg:7b braceleftBigg:7b bracerightBig:7d bracerightbig:7d bracerightbigg:7d bracerightBigg:7d" +
  " bracketleftbig:5b bracketleftBig:5b bracketleftbigg:5b bracketleftBigg:5b bracketrightBig:5d bracketrightbig:5d" +
  " bracketrightbigg:5d bracketrightBigg:5d contintegraldisplay:222e contintegraltext:222e coproductdisplay:2210" +
  " coproducttext:2210 integraldisplay:222b integraltext:222b logicalanddisplay:2227 logicalandtext:2227" +
  " logicalordisplay:2228 logicalortext:2228 parenleftBig:28 parenleftbig:28 parenleftBigg:28 parenleftbigg:28" +
  " parenrightBig:29 parenrightbig:29 parenrightBigg:29 parenrightbigg:29 prime:2032 productdisplay:220f" +
  " producttext:220f radicalbig:221a radicalBig:221a radicalBigg:221a radicalbigg:221a radicalbt:221a radicaltp:221a" +
  " radicalvertex:221a slashbig:2f slashBig:2f slashBigg:2f slashbigg:2f summationdisplay:2211 summationtext:2211" +
  " tildewide:2dc tildewider:2dc tildewidest:2dc vextenddouble:2225 vextendsingle:2223";

let agl: Map<string, number> | null = null;
let byUnicode: Map<number, string> | null = null;

function table(): Map<string, number> {
  if (!agl) {
    agl = new Map();
    byUnicode = new Map();
    for (const pair of AGL_DATA.split(" ")) {
      const i = pair.indexOf(":");
      const name = pair.slice(0, i);
      const cp = parseInt(pair.slice(i + 1), 16);
      agl.set(name, cp);
      if (!byUnicode.has(cp)) byUnicode.set(cp, name);
    }
  }
  return agl;
}

/** Is `name` an Adobe Glyph List name (as PDF/A wants in a TrueType's /Differences)? */
export function isAglName(name: string): boolean {
  return table().has(name);
}

/** The Adobe Glyph List name of a code point, when the list has one. */
export function aglNameFor(cp: number): string | undefined {
  table();
  return byUnicode!.get(cp);
}

/** The Unicode code point a glyph name stands for (AGL, uniXXXX, uXXXX[XX], name.suffix), or undefined — ligatures f_i style are left out. */
export function glyphNameToUnicode(name: string): number | undefined {
  const base = name.split(".")[0]!;
  const known = table().get(base);
  if (known !== undefined) return known;
  const uni = /^uni([0-9A-F]{4})/.exec(base);
  if (uni) return parseInt(uni[1]!, 16);
  const u = /^u([0-9A-F]{4,6})$/.exec(base);
  if (u) {
    const cp = parseInt(u[1]!, 16);
    return cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? cp : undefined;
  }
  if (base.length === 1 && /[A-Za-z]/.test(base)) return base.charCodeAt(0);
  return undefined;
}

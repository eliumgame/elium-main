/**
 * Le dictionnaire anglais embarqué : base + morphologie régulière.
 *
 * **Pourquoi l'anglais aussi.** Un document français cite des titres, des termes
 * techniques et des courriels en anglais ; et l'inverse existe — des documents
 * entièrement en anglais rédigés dans Elium. Sans dictionnaire anglais, la moitié
 * d'un tel texte serait soulignée, ce qui revient à devoir couper le correcteur.
 *
 * L'anglais est beaucoup plus régulier que le français : quatre suffixes (-s, -ed,
 * -ing, -ly) et deux règles orthographiques (le e final qui tombe, la consonne qui
 * double) couvrent l'essentiel. Seuls les verbes forts demandent une liste — elle
 * est ici, fléchie, parce qu'aucune règle ne mène de « go » à « went ».
 */

/** Le e final tombe devant une terminaison vocalique : make → making. */
function dropE(word: string): string {
  return /[^aeiou]e$/.test(word) ? word.slice(0, -1) : word;
}

/** La consonne finale double après une voyelle brève : stop → stopping. */
function doubleFinal(word: string): string {
  return /[aeiou][bdgklmnprt]$/.test(word) && !/[aeiou]{2}[bdgklmnprt]$/.test(word) ? word + word.slice(-1) : word;
}

/**
 * Toutes les formes régulières d'un mot anglais.
 *
 * Un seul générateur pour les noms, les verbes et les adjectifs : en anglais les
 * suffixes se recouvrent (« works » est un nom pluriel ET un verbe), et séparer les
 * catégories obligerait à étiqueter chaque entrée pour un gain nul.
 */
export function enForms(word: string): string[] {
  const w = word.trim().toLowerCase();
  if (!w) return [];
  const out = new Set<string>([w]);
  const stem = dropE(w);
  const dbl = doubleFinal(w);

  // Pluriel et 3e personne : -s, -es après une sifflante, -ies après consonne + y.
  if (/[sxz]$/.test(w) || /(?:ch|sh)$/.test(w)) out.add(`${w}es`);
  else if (/[^aeiou]y$/.test(w)) out.add(`${w.slice(0, -1)}ies`);
  else out.add(`${w}s`);

  // Prétérit et participe passé.
  if (/e$/.test(w)) out.add(`${w}d`);
  else if (/[^aeiou]y$/.test(w)) out.add(`${w.slice(0, -1)}ied`);
  else out.add(`${dbl}ed`);

  // Participe présent.
  out.add(`${dbl === w ? stem : dbl}ing`);

  // Comparatif, superlatif et adverbe : sur-générer est sans danger ici, une forme
  // inexistante n'est jamais SAISIE par erreur (« beautifuler » ne s'écrit pas).
  out.add(`${stem}er`);
  out.add(`${stem}est`);
  if (/[^aeiou]y$/.test(w)) out.add(`${w.slice(0, -1)}ily`);
  else if (/le$/.test(w)) out.add(`${w.slice(0, -1)}y`);
  else out.add(`${w}ly`);

  return [...out];
}

/** Vocabulaire anglais de base : le plus fréquent, plus le vocabulaire de bureau. */
export const EN_BASE = `
able about above accept access account across act add address after again against age agree
all allow almost also always among amount analysis and answer any appear apply approach approve
april area argue around arrive art article ask attach attempt attend august author available
avoid away
back bad balance bank base become before begin behind believe below benefit best better between
big bill board body book both box break bring budget build business but buy
call can cancel capital car card care carry case cash cause center central certain chair chance
change channel charge chart check child choice choose city claim class clean clear click client
close cloud code cold collect color come comment commit committee common company compare
complete computer concern condition confirm connect consider contact contain content continue
contract control cook copy corner correct cost could count country couple course cover create
credit current custom customer cut
data date day deal december decide decision deep default degree delete deliver demand
department depend describe design detail determine develop device did die difference difficult
digital direct director discuss display distribute divide document does dollar door double
doubt down download draft draw drive drop due during
each early earn east easy economy edit education effect effort either elect email employ
employee enable end energy engine english enough enter entire equal error escape especially
establish even event ever every exact example except exchange exist exit expect expense
experience explain export express extend extra
face fact factor fail fair fall family far fast father favor feature february feel few field
figure file fill film final finance find finish fire firm first fit fix flat floor flow focus
folder follow food foot for force forget form format forward found free friend from front full
fund future
game gap general get gift give glass global goal good government grant graph great green group
grow guarantee guide
half hand handle happen happy hard have head health hear heart heat help here high hire history
hold home hope hospital hot hour house how however human
idea identify image impact implement import important improve include income increase indeed
index indicate industry inform information input inside insert instead insurance interest
internal internet interview into introduce invest invoice involve issue item
january job join july jump june just
keep key kind know
label labor lack land language large last late launch law layer lead learn leave left legal
length less let letter level license life light like limit line link list listen little live
load loan local locate lock log long look loss love low
machine mail main maintain major make manage manager many march margin mark market match
material matter may maybe mean measure media medical meet member memory mention menu message
method middle might mind minute miss mobile model modern money month more morning most mother
motion mouse move much must
name nation near need network never new news next night none normal north not note nothing
notice november now number
object obtain occur october off offer office often oil only open operate opinion opportunity
option order organize other out output outside over own
package page paper part partner party pass password past pay payment people per percent
perform perhaps period permission person phone photo pick picture place plan plant play please
point policy political poor popular position possible post power practice prepare present
president press pressure prevent previous price print private probably problem process produce
product profit program project property propose protect provide public publish purchase
purpose push
quality quarter question quick quite quote
raise range rate rather reach read ready real reason receive recent record reduce refer reflect
refuse regard region register relate release remain remember remove repair repeat replace
report represent request require research reserve reset resource respect respond response
responsible rest result return revenue review right rise risk road role room rule run
safe sale same sample save say scale scan schedule school science score screen search season
seat second section secure see seem select sell send sense separate september series serious
serve service session set settle several share sheet shift ship shop short should show side
sign signal similar simple since single site situation size skill sleep slide slow small
social soft software sold solution solve some soon sort sound source south space speak special
specific speed spend split sponsor sport spread staff stage stand standard start state
statement station status stay step still stock stop storage store story strategy street strong
structure student study style subject submit success such suggest summary supply support sure
surface survey switch system
table take talk target task tax team technical technology tell term test text than thank that
the their them then there these they thing think third this those though thought thousand
three through throw thus ticket time title today together tomorrow tool top total touch toward
town track trade traffic train transfer transport travel treat trend trial trip true trust try
turn type
under understand union unit until update upload upon usage use user usual
value various version very video view village visit voice volume vote
wait walk wall want war warm warn watch water way weak wear website week weight welcome well
west what when where whether which while white who whole why wide will win window wish with
within without word work world worth would write wrong
year yes yesterday yet you young your
zone
`;

/**
 * Formes irrégulières, données telles quelles.
 *
 * Verbes forts et pluriels irréguliers : aucune règle n'y mène. La liste est
 * courte parce qu'en anglais l'irrégularité est concentrée sur quelques centaines de
 * formes très fréquentes — les manquer soulignerait « went » dans tous les textes.
 */
export const EN_IRREGULAR = `
am is are was were been being
have has had having
do does did done doing
go goes went gone going
say says said saying
get gets got gotten getting
make makes made making
know knows knew known knowing
think thinks thought thinking
take takes took taken taking
see sees saw seen seeing
come comes came coming
want wants wanted wanting
give gives gave given giving
find finds found finding
tell tells told telling
become becomes became becoming
leave leaves left leaving
feel feels felt feeling
put puts putting
bring brings brought bringing
begin begins began begun beginning
keep keeps kept keeping
hold holds held holding
write writes wrote written writing
stand stands stood standing
hear hears heard hearing
let lets letting
mean means meant meaning
set sets setting
meet meets met meeting
run runs ran running
pay pays paid paying
sit sits sat sitting
speak speaks spoke spoken speaking
lie lies lay lain lying
lead leads led leading
grow grows grew grown growing
lose loses lost losing
send sends sent sending
build builds built building
understand understands understood understanding
draw draws drew drawn drawing
break breaks broke broken breaking
spend spends spent spending
choose chooses chose chosen choosing
read reads reading
buy buys bought buying
teach teaches taught teaching
sell sells sold selling
catch catches caught catching
rise rises rose risen rising
drive drives drove driven driving
eat eats ate eaten eating
fall falls fell fallen falling
cut cuts cutting
deal deals dealt dealing
win wins won winning
forget forgets forgot forgotten forgetting
sleep sleeps slept sleeping
children men women people feet teeth mice geese
data criteria analyses bases crises theses indices matrices
`;

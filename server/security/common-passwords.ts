// Lista de bloqueio (NIST SP 800-63B-4 §3.1.1.2, ASVS 5.0 6.2.4/6.2.11): senhas e "miolos" de senha mais usados
// em vazamentos públicos, internacionais e brasileiros, mais palavras do próprio contexto (deck.slides, evento...).
// Tudo em minúsculas e sem acento. passwords.ts tira números e símbolos das pontas antes de comparar
// ("Flamengo2024!" -> "flamengo"), então cada palavra aqui cobre também as variações com enfeite.
// Não é exaustiva de propósito: o objetivo é barrar o que um ataque online tentaria primeiro, antes do limite
// de tentativas agir. Sequências e repetições são barradas por regra em passwords.ts, não por esta lista.
// ponytail: lista embutida (~1000). Para checar vazamentos de verdade (ASVS 6.2.12), um corpus local de hashes
// (ex.: HIBP baixado) entraria aqui; consulta a serviço externo está fora por decisão do projeto.
const LIST = `
senha senhas minhasenha suasenha novasenha senhanova senhaforte senhasegura senhasecreta senhafacil senhadificil
senhapadrao senhaboa senhatemporaria senhaprovisoria senhaadmin senhadoadmin senhamestre senhaunica senhapessoal
senhaacesso senhanumerica mudar mudarsenha mudeasenha mudaragora trocar trocarsenha troqueasenha alterar
alterarsenha acesso acessar entrar entrada login logon logar usuario usuaria usuarios cadastro conta minhaconta
suporte sistema sistemas teste testes testando padrao inicial temporaria temporario provisoria provisorio secreto
secreta segredo segredos privado privada pessoal confidencial seguranca seguro segura protegido protegida
bloqueado desbloquear liberado liberar password passwords passwort passwd mypassword newpassword oldpassword
yourpassword changeme changeit letmein letmeinnow welcome welcomeback welcomehome hello helloworld hellothere
secret secrets security secure default guest testing tester test admin admins administrator administrador
administradora administracao root rootroot superuser supervisor sysadmin webmaster manager master masterkey
access accessgranted private public internet online server servidor database bancodedados
deckslides deck slides slide evento eventos moderador moderadora moderacao palestra palestrante apresentacao
telao perguntas pergunta resposta respostas convite convidado convidada participante plateia auditorio

qwerty qwert qwertyu qwertyui qwertyuiop qwer asdf asdfg asdfgh asdfghj asdfghjk asdfghjkl zxcv zxcvb zxcvbn
zxcvbnm qazwsx qazwsxedc qazxsw qweasd qweasdzxc qwaszx azerty azertyuiop poiuytrewq lkjhgfdsa mnbvcxz ytrewq
abcd abcde abcdef abcdefg abcdefgh abcdefghi abcdefghij 1q2w3e4r5t6y 1q2w3e4r5t6y7u8i 1qaz2wsx3edc
1qaz2wsx3edc4rfv zaq12wsxcde3 1qazxsw23edc 123qweasdzxc qweasdzxc123 q1w2e3r4t5y6 a1b2c3d4e5f6 1a2b3c4d5e6f
123456654321 112233445566 111222333444 102030405060 1020304050607080 123456789abc abc123456789 147258369147
741852963741 963852741963 789456123789 159753456852 135792468024 246813579135 123123123123 147258369258

iloveyou iloveu iloveme loveyou loveme lovely lover lovers love mylove truelove princess prince queen king
dragon monkey football baseball basketball soccer hockey softball volleyball tennis shadow sunshine superman
batman spiderman ironman captain starwars startrek trustno trustme freedom whatever nothing something
everything cheese computer biteme corvette yankees mustang ferrari porsche mercedes chevrolet camaro google
facebook instagram youtube twitter linkedin microsoft apple samsung iphone android windows linux ubuntu hacker
hacked hackme matrix merlin gandalf phoenix tigger tiger lion eagle falcon wolf panther dolphin horse donkey
turtle rabbit kitty kitten puppy doggy snoopy scooby mickey minnie disney barbie hellokitty pokemon pikachu
naruto sasuke goku dragonball minecraft fortnite roblox zelda mario sonic halo killer gangster money blessed
jesus christ faith heaven family friends forever happy smile cookie chocolate banana orange cherry peanut
coffee butterfly rainbow unicorn flower flowers angel angels babygirl baby sweety sweetheart sweetie honey cutie
pretty beautiful sexy hottie playboy diamond silver golden purple yellow green blue black white redsox lakers
cowboys steelers eagles packers patriots raiders broncos chicago boston dallas london paris berlin america
canada mexico england france germany italy spain brazil australia rockyou tinkerbell poohbear spongebob
eminem bubbles chicken tweety jasmine destiny dancer junior fuckyou fuckoff summer winter spring autumn
harrypotter hogwarts avengers marvel onepiece freefire playstation xbox nintendo gamer games jogos neymar
messi ronaldo cristiano ronaldinho kaka zico romario anitta ivete xuxa beyonce rihanna shakira madonna
metallica nirvana beatles legiaourbana titas raulseixas mamonas

amor amore meuamor amormeu amorzinho amorzao amoreterno amorproprio teamo teamomuito eteamo teadoro adoro
paixao saudade saudades carinho coracao coracaozinho princesa principe rainha gatinha gatinho gatona gatao
lindinha lindinho lindona linda lindo fofinha fofinho docinho florzinha bebezinho bebezinha nenem filho
filha filhos filhote familia familiafeliz minhafamilia mamae papai irmao esposa marido namorada namorado
felicidade alegria sorriso sucesso vitoria vencedor vencedora guerreiro guerreira campeao campea liberdade
esperanca gratidao gratiluz abencoada abencoado deusefiel deuseamor deusefieldemais deusmeguie deusemeupastor
deuseopai deus jesuscristo jesusteama jesusmeama cristo senhor senhorjesus gloria gloriaadeus aleluia
nossasenhora aparecida amem igreja biblia salmo salmos oracao anjo anjinho anjinha anjos estrela estrelinha
luar solzinho praia natureza borboleta rosa margarida girassol orquidea morango brigadeiro pipoca cerveja
cachaca caipirinha futebol capoeira carnaval samba pagode funk forro sertanejo musica cantora cantor brasil
brasileiro brasileira riodejaneiro minasgerais salvador recife curitiba portoalegre brasilia manaus belem
goiania campinas natal florianopolis santacatarina parana pernambuco maranhao amazonas espiritosanto paraiba
alagoas sergipe piaui tocantins rondonia roraima amapa acre matogrosso computador celular notebook trabalho
escola faculdade empresa escritorio cachorro cachorrinho cachorra gato cavalo leao tigre aguia lobo pantera
macaco golfinho tartaruga coelho passaro dragao unicornio demonio diabo inferno paraiso sabado domingo segunda
janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro primavera verao
outono inverno azul vermelho verde amarelo preto branco roxo laranja cinza dinheiro rico riqueza milionario
sorte sortudo vida minhavida vidaloka bonita bonito gostosa gostoso safada safado mozao mozinho benzinho xuxu
xuxuzinho chuchu meubem meuamorzinho minhaprincesa meuprincipe caralho porra

flamengo mengao mengo flamenguista corinthians corintiano timao palmeiras palmeirense verdao saopaulo spfc
saopaulino vasco vascodagama vascaino gremio gremista internacional inter colorado cruzeiro cruzeirense atletico
atleticano galo atleticomineiro botafogo botafoguense fogao fluminense tricolor santos peixe bahia esporte sport
coritiba athletico furacao fortaleza ceara goias paysandu remo nautico figueirense avai chapecoense juventude
bragantino cuiaba pontepreta guarani portuguesa torcedor realmadrid barcelona juventus milan chelsea arsenal
liverpool manchester bayern

maria joao jose antonio francisco carlos paulo pedro lucas luiz marcos luis gabriel rafael daniel marcelo bruno
eduardo felipe raimundo rodrigo manoel mateus matheus andre fernando fabio leonardo gustavo guilherme leandro
tiago thiago anderson ricardo marcio jorge sebastiao alexandre roberto edson diego vitor victor sergio claudio
joaquim julio cesar renato adriano juliana adriana marcia fernanda patricia aline sandra camila amanda bruna
jessica leticia julia luciana vanessa mariana gabriela vera larissa claudia beatriz luana rita sonia renata
eliane simone isabela isabella sophia sofia alice laura manuela valentina heloisa helena giovanna lorena livia
cecilia eduarda mariaeduarda mariaclara anaclara analuiza anajulia joaopedro joaovitor joaogabriel
pedrohenrique carloseduardo luizfelipe enzo miguel arthur heitor bernardo davi theo lorenzo samuel benjamin
nicolas henrique murilo caio vinicius igor otavio rogerio wellington wesley william washington jefferson michel
michele michelle debora daniela danielle natalia nathalia priscila tatiana tatiane carolina caroline karina
karen kelly katia monica raquel rebeca sabrina silvia tereza viviane yasmin yasmim thais thaynara bianca
barbara carla cristina cristiane denise elaine fabiana flavia gisele ingrid jaqueline joana josiane lais leila
lucia luiza marina marta mirella nayara paula pamela poliana rosana roberta rosangela samara stefany tamires
antonella agatha clara emanuelly esther isis jade lara lavinia melissa nicole pietra rafaela sarah stella

michael jennifer ashley david james john robert richard joseph thomas charles christopher matthew anthony mark
steven andrew joshua kevin brian george edward ronald timothy jason jeffrey ryan jacob gary eric jonathan
stephen larry justin scott brandon frank gregory raymond alexander patrick jack dennis jerry tyler aaron
adam douglas nathan peter zachary kyle walter harold jeremy ethan carl keith roger gerald christian terry sean
austin noah lawrence jesse bryan billy jordan albert dylan bruce alan juan logan wayne ralph eugene randy
vincent russell louis philip bobby johnny bradley hunter ranger harley charlie pepper maggie buster ginger
taylor mary linda elizabeth susan margaret nancy lisa betty dorothy donna carol ruth sharon emily kimberly
deborah stephanie amy anna angela brenda samantha katherine christine emma catherine debra rachel carolyn
janet virginia heather diane julie joyce victoria christina joan evelyn lauren judith olivia martha cheryl
megan andrea hannah jacqueline jean kathryn teresa sara janice doris madison grace judy abigail marie beverly
amber theresa marilyn diana brittany natalie rose alexis kayla charlotte alexandra adrian destiny sakura
`

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(LIST.split(/\s+/).filter((w) => w.length >= 4))

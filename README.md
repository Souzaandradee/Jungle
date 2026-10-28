# Distributed Wagering Processor

Implementação em TypeScript do [desafio de backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge). O README original do desafio é a fonte dos requisitos funcionais; as decisões que o desafio deixa ao candidato estão documentadas em [ARCHITECTURE.md](ARCHITECTURE.md). O mapa de leitura do código e dos caminhos críticos está em [docs/FLUXOS_CRITICOS.md](docs/FLUXOS_CRITICOS.md).

## 1. O que a aplicação faz

O sistema processa operações de apostas recebidas por HTTP ou SQS, atualiza carteiras, mantém um ledger financeiro auditável e publica eventos de integração por meio de uma transactional outbox.

Operações suportadas:

| Operação | Efeito | Regra principal |
| --- | --- | --- |
| BET | Débito | Rejeita saldo insuficiente. |
| WIN | Crédito | Pode referenciar uma BET processada da mesma rodada e do mesmo contexto. |
| LOSS | Nenhum | Registra o resultado sem lançamento no ledger. |
| REFUND | Crédito | Exige uma BET processada, o mesmo valor e no máximo um REFUND processado para a referência. |
| ROLLBACK | Inverso do lançamento referenciado | Exige uma BET, WIN ou REFUND processada, o mesmo valor e no máximo um ROLLBACK processado para a referência. |

Uma referência ausente ou ainda em processamento pode levar a transação para PENDING_REFERENCE. Um worker tenta processá-la novamente com backoff limitado; após dez tentativas, a transação é rejeitada com REFERENCE_NOT_FOUND.

## 2. Stack e ferramentas utilizadas

| Componente | Uso neste repositório |
| --- | --- |
| Bun 1.x | Runtime, instalação de dependências e test runner. |
| TypeScript 5.7.x, modo strict | Linguagem e verificação estática. |
| NestJS 10 | Bootstrap da aplicação, controllers e injeção de dependências. |
| MikroORM 6 + PostgreSQL driver | Gerenciamento de conexão e transações; SQL explícito nos caminhos críticos. |
| PostgreSQL 17 (imagem alpine) | Fonte de verdade dos saldos, transações, ledger, inbox e outbox. |
| AWS SDK for JavaScript v3 / SQS | Recepção e publicação de mensagens. |
| LocalStack 4 | Emulação local de SQS. |
| Docker Engine + Docker Compose | Ambiente local com dependências e três instâncias da API. |
| decimal.js | Aritmética monetária exata sem conversão de valores para number. |
| class-validator + class-transformer | Validação dos contratos HTTP. |
| prom-client | Exposição de métricas Prometheus em /metrics. |
| bun.lock | Resolução bloqueada das dependências JavaScript. |
| GitHub Actions | Typecheck, build, testes unitários e integração com containers reais. |

As faixas de versões e dependências exatas estão declaradas em package.json e bun.lock. As versões dos serviços Docker estão em docker-compose.yml. A autenticação de identidade externa é intencionalmente um ponto de extensão no-op, conforme permitido pelo desafio; veja ARCHITECTURE.md.

## 3. Arquitetura em uma visão

- **API NestJS:** três instâncias locais escutam nas portas 3000, 3001 e 3002.
- **PostgreSQL:** aplica constraints, índices únicos, transações e triggers que protegem as invariantes financeiras.
- **SQS/LocalStack:** fila de entrada, dead-letter queue (DLQ) e fila de eventos.
- **Inbox:** impede reaplicar uma mensagem SQS cuja transação já foi confirmada.
- **Outbox:** grava eventos no mesmo commit da operação financeira; publishers os enviam após o commit.
- **Workers:** reprocessam mensagens SQS, publicam a outbox e tentam resolver transações com referências fora de ordem.

O sistema não depende de locks em memória para a correção financeira. O bloqueio de concorrência é por wallet no PostgreSQL; wallets diferentes podem avançar em paralelo.

## 4. Tutorial completo: preparar e subir o ambiente local

Este procedimento sobe tudo que o projeto precisa para operar localmente: PostgreSQL, LocalStack/SQS, migrations e três instâncias da API. Os comandos abaixo consideram Bash, WSL ou um terminal Linux/macOS. No Windows, use WSL ou adapte os comandos para PowerShell.

### 4.1 Pré-requisitos

Instale e confirme:

1. Git.
2. Docker Engine e o plugin Docker Compose v2.
3. Bun 1.x, caso queira executar testes e scripts do projeto diretamente no host. Para apenas subir a aplicação via Docker, Bun no host não é necessário.

Verifique:

~~~bash
git --version
docker --version
docker compose version
bun --version
~~~

A última linha só é necessária para os comandos de Bun executados no host. Inicie o Docker antes de continuar.

### 4.2 Obter o código e usar a versão integrada

O repositório é público. As alterações da branch `fix/readme-compliance-ledger-logging` foram integradas à `main` pelo [PR #2](https://github.com/joao-henrike/challenge/pull/2). Para obter a versão atual, use a `main`; não é necessário fazer checkout da branch de trabalho antiga.

**Clone novo:**

~~~bash
git clone --branch main --single-branch https://github.com/souzaandradee/challenge.git
cd challenge
git status
git log -1 --oneline
~~~

**Se você já tem o repositório clonado:**

~~~bash
cd challenge
git fetch origin
git switch main
git pull --ff-only origin main
git log -1 --oneline
~~~

O `git pull --ff-only` atualiza a `main` local sem criar um merge commit local. Se houver alterações locais não commitadas, preserve-as e revise o `git status` antes de trocar de branch.

### 4.3 Entender as variáveis de ambiente

docker-compose.yml contém os valores de desenvolvimento usados pelos containers. O arquivo .env.example é uma referência para execução local e documentação; ele não contém credenciais de produção.

O ambiente Compose configura:

| Variável | Valor local / propósito |
| --- | --- |
| NODE_ENV | production dentro dos containers, para executar o bundle compilado. |
| PORT | 3000 dentro de cada container; as portas do host são 3000, 3001 e 3002. |
| DATABASE_HOST / PORT | postgres / 5432 na rede Compose. |
| DATABASE_NAME / USER / PASSWORD | wagering / wagering / wagering, somente para desenvolvimento local. |
| AWS_REGION | sa-east-1. |
| AWS_ENDPOINT_URL | endpoint LocalStack, http://localstack:4566 dentro da rede Compose. |
| SQS_TRANSACTIONS_QUEUE_URL | Fila de entrada wager-transactions.fifo. |
| SQS_DLQ_QUEUE_URL | Fila de falhas wager-transactions-dlq.fifo. |
| SQS_EVENTS_QUEUE_URL | Destino de eventos wager-events.fifo. |
| SQS_VISIBILITY_TIMEOUT_SECONDS | Timeout de visibilidade; padrão 30 segundos. |
| ENABLE_TEST_FAULT_INJECTION | 0 por padrão; habilita hooks de falha apenas durante testes específicos quando definido como 1. |

Não use as senhas, as chaves AWS “test” ou os endpoints do LocalStack em produção. A configuração de AWS real deve usar IAM Roles ou a cadeia de credenciais padrão do SDK e endpoints SQS reais.

### 4.4 Subir o ambiente sem sobrecarregar o host (recomendado)

O Compose completo inclui PostgreSQL, LocalStack/SQS, migrations e três instâncias da API. O primeiro build pode usar bastante CPU e memória. Em computadores com recursos limitados, comece com **uma única instância da API** e limite os recursos de execução dos containers.

Crie um arquivo local de limites, sem modificar o `docker-compose.yml` versionado:

~~~bash
cat > compose.safe.yaml <<'YAML'
services:
  postgres:
    mem_limit: 512m
    cpus: 0.50
  localstack:
    mem_limit: 1g
    cpus: 1.00
  migrate:
    mem_limit: 512m
    cpus: 0.50
  api:
    mem_limit: 512m
    cpus: 0.50
  api-2:
    mem_limit: 512m
    cpus: 0.50
  api-3:
    mem_limit: 512m
    cpus: 0.50
YAML
~~~

Valide a configuração combinada antes de iniciar:

~~~bash
docker compose -f docker-compose.yml -f compose.safe.yaml config --quiet
~~~

Construa somente os serviços necessários para o primeiro teste, limitando a concorrência do Compose:

~~~bash
COMPOSE_PARALLEL_LIMIT=1 docker compose -f docker-compose.yml -f compose.safe.yaml build migrate api
~~~

Os limites de memória e CPU acima valem para os containers em execução; eles não limitam a memória usada pelo processo de build. A concorrência reduzida evita builds simultâneos do Compose, mas um build individual ainda pode consumir bastante memória.

Depois do build, inicie o banco, o LocalStack, a migration e apenas a primeira API:

~~~bash
docker compose -f docker-compose.yml -f compose.safe.yaml up --no-build -d postgres localstack migrate api
~~~

Confira o estado e os logs:

~~~bash
docker compose -f docker-compose.yml -f compose.safe.yaml ps -a
docker compose -f docker-compose.yml -f compose.safe.yaml logs --tail=100 postgres localstack migrate api
docker stats --no-stream
~~~

O serviço `migrate` aparecer como `Exited (0)` é normal quando as migrations terminam com sucesso. A API deve permanecer em execução.

**Quando precisar testar as três instâncias**, e o host estiver estável, construa as imagens restantes em série e inicie a stack completa:

~~~bash
COMPOSE_PARALLEL_LIMIT=1 docker compose -f docker-compose.yml -f compose.safe.yaml build migrate api api-2 api-3
docker compose -f docker-compose.yml -f compose.safe.yaml up --no-build -d postgres localstack migrate api api-2 api-3
~~~

Não repita o build se o computador começar a congelar. Pare e confira a memória disponível, o espaço em disco e os logs antes de continuar.

### 4.5 Confirmar saúde e filas

No modo recomendado, com uma única instância da API:

~~~bash
curl --fail http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
~~~

Se você iniciou a stack completa, confira também as outras duas instâncias:

~~~bash
curl --fail http://localhost:3001/health/ready
curl --fail http://localhost:3002/health/ready
~~~

Esperado: `/health/live` responde com status ok; `/health/ready` informa ready e confirma PostgreSQL e SQS alcançáveis.

Para listar as filas criadas pelo script de inicialização do LocalStack:

~~~bash
docker compose -f docker-compose.yml -f compose.safe.yaml exec localstack awslocal sqs list-queues
~~~

As três filas locais são `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. A fila de eventos é uma decisão local de implementação: o desafio exige publicação de eventos, mas não fixa o nome dessa fila.

### 4.6 Fazer uma primeira chamada: criar uma wallet

Use um UUID válido para playerId. O UUID abaixo é apenas um exemplo local:

~~~bash
curl -i -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
~~~

Guarde o campo id retornado na resposta; ele será o walletId para as chamadas seguintes. O saldo inicial maior que zero grava uma transação OPENING e um lançamento CREDIT no ledger, na mesma transação SQL da criação da carteira.

Criar outra wallet para o mesmo playerId e currency retorna conflito (409).

### 4.7 Submeter uma aposta por HTTP

Substitua WALLET_UUID pelo id real retornado na etapa anterior e mantenha o playerId igual ao da wallet:

~~~bash
curl -i -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "WALLET_UUID",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
~~~

Uma aposta processada retorna status PROCESSED e saldo 975.00 BRL para o exemplo. A mesma chamada com a mesma chave e o mesmo payload reproduz a resposta persistida sem um segundo débito. Reutilizar a chave com payload diferente retorna conflito (409).

Não envie WALLET_UUID literalmente: substitua-o pelo UUID real.

### 4.8 Conferir carteira, ledger e reconciliação

Substitua WALLET_UUID pelo mesmo id:

~~~bash
curl --fail http://localhost:3000/wallets/WALLET_UUID
curl --fail 'http://localhost:3000/wallets/WALLET_UUID/ledger?limit=50'
curl --fail -X POST http://localhost:3000/wallets/WALLET_UUID/reconciliation
~~~

A reconciliação compara o saldo persistido com a soma líquida de todos os lançamentos do ledger. O campo consistent deve ser true em um cenário normal. Divergências são registradas em log e métrica; a aplicação não corrige o saldo silenciosamente.

### 4.9 Consultar transação, métricas e logs

~~~bash
curl --fail http://localhost:3000/wagering/transactions/TRANSACTION_UUID
curl --fail http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123
curl --fail http://localhost:3000/metrics
docker compose logs -f api api-2 api-3
~~~

Use o UUID interno retornado na resposta para consultar por transactionId. /metrics expõe métricas no formato Prometheus. Os logs são JSON e devem conter identificadores de correlação, não o payload financeiro completo.

### 4.10 Testar a entrada SQS manualmente

Uma mensagem válida precisa seguir o envelope WagerTransactionRequested e incluir messageId, type, occurredAt e data. A data deve ter os campos de negócio exigidos pela API, incluindo idempotencyKey, playerId, walletId, kind e money. O formato oficial está na seção de SQS do README do desafio e na implementação de src/infra/sqs/sqs-worker.service.ts.

Para não consumir a fila sem querer, use uma wallet de teste e IDs externos/chaves de idempotência exclusivos. Você pode enviar uma mensagem para a fila local assim, substituindo WALLET_UUID e PLAYER_UUID por IDs válidos. O comando abaixo usa um valor ilustrativo e deve ser adaptado aos seus dados:

~~~bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/queue/sa-east-1/000000000000/wager-transactions.fifo \
  --message-group-id WALLET_UUID \
  --message-deduplication-id manual-test-001 \
  --message-body '{"messageId":"manual-message-001","type":"WagerTransactionRequested","occurredAt":"2026-10-23T12:00:00.000Z","data":{"providerId":"manual-provider","externalTransactionId":"manual-tx-001","idempotencyKey":"manual-provider:manual-tx-001","playerId":"PLAYER_UUID","walletId":"WALLET_UUID","roundId":"manual-round","gameId":"manual-game","kind":"BET","money":{"amount":"1.00","currency":"BRL"}}}'
~~~

A chamada de teste é intencionalmente explícita. IDs de exemplo precisam ser substituídos por UUIDs de uma wallet existente; cada novo teste deve usar messageId, externalTransactionId e Idempotency-Key inéditos. Não assuma que publicar uma mensagem significa que ela já foi processada: consulte o estado da transação e a carteira.

## 5. Endpoints disponíveis

| Método | Endpoint | Descrição |
| --- | --- | --- |
| POST | /wallets | Cria uma wallet e, se houver saldo inicial positivo, grava OPENING e ledger. |
| GET | /wallets/:walletId | Consulta saldo e versão. |
| GET | /wallets/:walletId/ledger?cursor=...&limit=50 | Lista lançamentos com paginação por cursor estável. |
| POST | /wallets/:walletId/reconciliation | Reconcilia o saldo materializado com o ledger. |
| POST | /wagering/transactions | Submete uma operação; exige Idempotency-Key. |
| GET | /wagering/transactions/:transactionId | Consulta pelo identificador interno. |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId | Consulta pelo identificador externo do provedor. |
| GET | /health/live | Liveness, sem verificar dependências. |
| GET | /health/ready | Verifica PostgreSQL e filas SQS. |
| GET | /metrics | Métricas Prometheus. |

### Status HTTP usados pela API

- 200: transação aplicada ou replay idempotente; também usado por endpoints de consulta.
- 202: operação aceita e aguardando referência.
- 400: payload inválido ou header obrigatório ausente.
- 404: wallet ou transação não encontrada.
- 409: conflito de idempotência ou identificador externo duplicado.
- 422: rejeição por regra de negócio, com failureCode estável.
- 503: dependência indisponível ou falha transitória reconhecida.

## 6. Testes, validação e migrations

### Testes unitários

Com Bun 1.x instalado, na raiz do repositório:

~~~bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
~~~

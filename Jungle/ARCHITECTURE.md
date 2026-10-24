# Decisões de arquitetura

## 1. Limite do escopo

O README do [desafio original](https://github.com/junglegaming/backend-challenge) é a fonte funcional. As decisões abaixo descrevem como os requisitos são implementados e documentam escolhas que o desafio deixa ao candidato; não introduzem novos fluxos de negócio.

A aplicação é um backend NestJS único, com PostgreSQL como autoridade financeira, SQS para mensageria e workers dentro do processo. O Compose local roda três instâncias da mesma aplicação para exercitar concorrência distribuída. Não há microserviços separados, cache de negócio ou event bus em memória.

## 2. Stack efetivamente usada

- Bun 1.x para runtime, gerenciador de pacotes e testes; TypeScript estrito.
- NestJS 10 para HTTP, controllers e injeção de dependências.
- MikroORM 6 com PostgreSQL driver para conexão/transações/migrations; SQL explícito nos pontos em que locks, constraints e operações atômicas precisam ficar visíveis.
- PostgreSQL 17 em desenvolvimento local.
- AWS SDK for JavaScript v3 para SQS e LocalStack 4 para emulação local.
- decimal.js para aritmética monetária exata.
- class-validator e class-transformer para validação dos DTOs.
- prom-client para métricas Prometheus.
- Docker Compose para PostgreSQL, LocalStack, migration e três instâncias da API.
- Bun test para unidades e integração; GitHub Actions executa a validação automatizada.

As versões compatíveis/declaradas ficam em package.json e bun.lock; as imagens locais estão em docker-compose.yml. O README contém o tutorial de instalação e execução.

## 3. Organização dos módulos

- src/domain: Money, Wallet, WagerTransaction, WalletLedgerEntry, inbox/outbox e envelopes de eventos. As classes de domínio usam construtores privados e factories estáticas.
- src/wallets: criação e consulta de wallets, paginação do ledger e reconciliação.
- src/wagering: submissão de transações, regras de negócio e processamento de referências pendentes. HTTP e SQS reutilizam o mesmo serviço.
- src/infra/database: configuração MikroORM, SQL explícito, writer da outbox e mapping mínimo necessário.
- src/infra/sqs: cliente SQS, consumidor e publisher da outbox.
- src/infra/logging: logger JSON e filtro global de exceções.
- src/infra/metrics: métricas Prometheus.
- src/health: liveness e readiness.
- migrations: schema versionado e migrations reversíveis.
- test/unit e test/integration: validações de domínio, persistência, concorrência e falhas.

A estrutura mantém o processamento financeiro num único caso de uso compartilhado. O SQL é explícito apenas nos caminhos críticos para facilitar auditoria de locks, updates, conflitos e transações.

## 4. Dinheiro e moedas

Os contratos recebem amount como string decimal com exatamente duas casas, entre 0.00 e 999999999999999999.99, compatível com numeric(20,2). A validação de formato acontece antes de construir um Decimal; valores monetários não são convertidos para number. A serialização preserva duas casas.

A allow-list de moedas fica em src/domain/currency.ts e também é imposta pelo PostgreSQL via is_iso4217_currency. A lista inclui códigos monetários, de fundos e metais definidos pelo conjunto adotado no repositório; XTS (teste) e XXX (sem moeda) são excluídos. A lista explícita evita que o comportamento varie com a versão de ICU do runtime. Atualizações dessa lista exigem revisar domínio, DTOs, migration e testes juntos.

Money é imutável. Operações aritméticas verificam a moeda e limitam o resultado ao intervalo representável no saldo numeric(20,2). A subtração pode produzir resultado negativo no objeto de domínio, porque reconciliação precisa representar diferenças assinadas; contratos monetários públicos continuam não negativos.

## 5. Wallet, saldo e concorrência

Cada wallet é única por (player_id, currency). A versão inicia em 1 e avança somente quando o saldo muda.

Cada operação financeira roda numa transação PostgreSQL. A wallet é bloqueada com SELECT ... FOR NO KEY UPDATE antes de verificar o saldo. Isso serializa as mudanças na mesma wallet, enquanto wallets diferentes podem avançar em paralelo. Não há lock global em memória. Um update do saldo é escrito apenas quando ele muda, e a versão só avança junto com a mudança.

A correção é reforçada no banco por saldo não negativo, unicidade, FK e constraints aritméticas. SQS FIFO e MessageGroupId são auxiliares de ordenação; não substituem o lock transacional no banco.

## 6. Ledger e reconciliação

O saldo materializado e seu lançamento no ledger são gravados na mesma transação. Cada transação pode produzir no máximo um lançamento, por unique constraint sobre transaction_id. LOSS e transações rejeitadas não criam lançamento. OPENING é interno e cria transação/ledger de crédito quando a wallet nasce com saldo inicial positivo.

A constraint ledger_arithmetic_ck assegura balance_before - amount = balance_after para DEBIT ou balance_before + amount = balance_after para CREDIT. Os saldos e montantes do ledger não podem ser negativos.

O ledger é imutável no PostgreSQL:
- wallet_ledger_immutable_trg bloqueia UPDATE e DELETE por linha.
- wallet_ledger_no_truncate_trg bloqueia TRUNCATE a nível de statement.
- a segunda proteção foi adicionada na migration reversível Migration20261023000000.ts, pois um trigger por linha não intercepta TRUNCATE.

A reconciliação lê o saldo da carteira e a soma líquida do ledger em um único statement SQL. Isso impede que uma escrita concorrente faça a comparação usar snapshots distintos. SUM(numeric) fica fora do limite da coluna do saldo porque débitos e créditos acumulados ao longo da vida podem ser individualmente maiores que o saldo líquido atual. Divergências são reportadas, logadas e contabilizadas em métrica; nunca são corrigidas silenciosamente.

## 7. Idempotência

Idempotency-Key HTTP é obrigatória e é a fonte de verdade da intenção da chamada. O payloadHash é SHA-256 sobre JSON canônico dos campos de negócio normalizados, com chaves de objetos ordenadas. A chave idempotente e metadados de transporte não entram no hash.

- Mesma chave e mesmo hash: retorna o registro/resposta de saldo original persistido, com idempotentReplay true.
- Mesma chave e payload divergente: retorna 409.
- Mesmo par (provider_id, external_transaction_id): é único no banco.
- OPENING usa chave interna determinística por wallet.

A inbox protege especificamente a entrega de mensagens SQS: primary key (consumer_name, message_id). O registro de inbox, transação financeira, ledger e outbox participam do mesmo commit. Um conflito de inbox com payload diferente gera conflito; uma redelivery da mesma mensagem não reaplica o efeito financeiro.

## 8. Regras de transação e referências fora de ordem

BET debita saldo e rejeita com INSUFFICIENT_FUNDS quando não há saldo suficiente. WIN credita saldo; se uma referência for fornecida, ela precisa ser uma BET processada no mesmo contexto. LOSS grava o resultado sem movimentação financeira.

REFUND exige referência a BET processada; ROLLBACK exige referência processada a BET, WIN ou REFUND e inverte o sentido do lançamento original. REFUND e ROLLBACK exigem mesmo provedor, jogador, wallet, moeda, rodada e valor. Cada tipo de reversão só pode ser processado uma vez por referência, protegido por índice parcial único. Uma reversão que geraria saldo negativo é rejeitada com REVERSAL_INSUFFICIENT_BALANCE.

Quando a referência exigida não existe ou continua PENDING/PENDING_REFERENCE, a operação é marcada PENDING_REFERENCE e reprocessada por worker com backoff exponencial de 1 segundo até 60 segundos. O limite é dez tentativas; ao esgotá-lo, a transação é rejeitada com REFERENCE_NOT_FOUND. O worker consulta candidatos vencidos e o serviço bloqueia a linha com FOR UPDATE SKIP LOCKED antes de reprocessar. As regras de referência são sempre revalidadas pelo caso de uso.

## 9. SQS, retry e DLQ

O LocalStack inicializa as filas:
- wager-transactions.fifo: comandos de transação.
- wager-transactions-dlq.fifo: mensagens que falharam de forma permanente/inválida ou excederam retries.
- wager-events.fifo: publicação local da outbox.

A fila de eventos é uma escolha de implementação local porque o desafio não fixa o nome da fila de saída.

O consumidor valida o envelope e o contrato da mensagem antes de submeter o mesmo caso de uso usado por HTTP. Uma rejeição de negócio persistida é terminal e recebe ACK. Payload inválido e falhas permanentes vão para DLQ; falhas transitórias têm backoff limitado e até quatro recebimentos tratados pela aplicação. O redrive configurado na fila também tem limite de segurança. A mensagem original só é apagada após o envio confirmado à DLQ; se esse envio falhar, a mensagem é mantida para nova tentativa.

A confirmação SQS ocorre depois do commit financeiro/inbox. Em shutdown, o worker espera a operação em andamento e devolve a visibilidade das mensagens ainda não iniciadas. Hooks que simulam falha transitória e crash entre commit e ACK são opt-in via ENABLE_TEST_FAULT_INJECTION=1.

## 10. Transactional outbox e semântica de entrega

Eventos são criados como envelopes versionados com eventId, eventType, aggregateId, correlationId, causationId opcional, occurredAt, version e data. O payload carrega valores monetários serializados em strings, não instâncias de Money.

A outbox é gravada dentro da transação financeira. O publisher seleciona pendências com FOR UPDATE SKIP LOCKED, envia para SQS e marca published_at após o sucesso. Falhas recebem backoff e permanecem reprocessáveis. Se o envio for aceito por SQS mas o processo falhar antes de confirmar published_at, um duplicado pode ser publicado. A semântica é, portanto, at-least-once, não exactly-once; eventId é o identificador estável que consumidores devem usar para deduplicar.

**Limitação importante de ordenação:** SKIP LOCKED coordena a reivindicação de linhas, mas não garante ordem estrita de publicação de eventos diferentes do mesmo aggregate_id quando vários publishers trabalham simultaneamente. SQS FIFO mantém a ordem de chegada ao broker para um MessageGroupId, mas publishers concorrentes podem enviar eventos na ordem inversa à criação original. Os consumidores devem deduplicar por eventId e respeitar versão/contexto do agregado. Se a ordem estrita for requisito, será necessária uma estratégia explícita de serialização/sequence por agregado e testes específicos; os testes atuais de publisher concorrente provam entrega dos eventos, não a ordem estrita de atualizações de saldo.

## 11. API e códigos de resposta

Endpoints:
- POST /wallets
- GET /wallets/:walletId
- GET /wallets/:walletId/ledger?cursor=...&limit=50
- POST /wallets/:walletId/reconciliation
- POST /wagering/transactions (Idempotency-Key obrigatório)
- GET /wagering/transactions/:transactionId
- GET /providers/:providerId/wagering/transactions/:externalTransactionId
- GET /health/live
- GET /health/ready
- GET /metrics

Mapeamento principal: 200 para transação processada/replay; 202 para referência pendente; 400 para entrada inválida/header ausente; 404 para recurso não encontrado; 409 para conflito de idempotência/ID externo; 422 para rejeição de negócio com failureCode; 503 para indisponibilidade transitória reconhecida ou readiness indisponível.

## 12. Identidade e segurança

O README do desafio permite não implementar autenticação, pois ela não vale pontos; nesse caso, a decisão deve ser documentada e o ponto de extensão precisa existir. O projeto fornece ProviderIdentityPort e NoopProviderIdentityAdapter. Este adapter não autentica nem autoriza de verdade e deve ser substituído por uma integração com IdP externo, como Keycloak ou Zitadel, antes de uma implantação real que exija identidade de provedor.

Não existe tabela local de senhas. Health checks são públicos. Mensagens SQS são tratadas como canal interno confiável, conforme o desafio, mas os dados do provedor continuam sujeitos às regras do domínio.

As credenciais “test”, senhas e endpoints em docker-compose.yml/.env.example são valores locais. **Atenção:** src/infra/sqs/sqs-client.service.ts configura credenciais explícitas e usa test como fallback; remover as variáveis não faz o SDK recorrer à IAM Role nesta versão. Antes de uma implantação AWS, altere o cliente para fornecer credenciais explícitas somente quando forem configuradas e, caso contrário, deixe o SDK usar sua cadeia padrão/IAM Role. Logs não devem incluir payload financeiro completo. Privilégios no banco de produção devem impedir que a conta de aplicação altere schema ou desative triggers; triggers protegem contra operações comuns, não contra um administrador com privilégios irrestritos.

## 13. Logs, métricas e health checks

StructuredLogger emite JSON com timestamp, level, message e chaves de contexto estáveis: correlationId, messageId, transactionId, walletId e providerId, com null quando não se aplicam. O filtro de exceções evita devolver detalhes internos em erros inesperados e mapeia alguns erros transitórios conhecidos para 503.

MetricsService expõe, entre outras, estas famílias:
- wager_transactions_total
- wager_idempotent_duplicates_total
- wager_retries_total
- wager_dlq_messages
- wager_lock_conflicts_total
- wager_outbox_lag_seconds
- wager_processing_latency_seconds
- wager_reconciliation_mismatches_total

/health/live verifica que o processo responde. /health/ready tenta verificar PostgreSQL e as três filas configuradas. /metrics expõe o formato Prometheus.

Os logs do publisher derivam transactionId e walletId dos dados do envelope do evento, em vez de presumir que aggregate_id é uma transação. Quando um evento não tem um identificador de transação, o campo fica ausente ou nulo; não deve ser fabricado.

## 14. Migrations e garantias de schema

Migration20261022000000 cria as tabelas, índices, constraints, função ISO 4217, inbox/outbox e trigger de imutabilidade UPDATE/DELETE. Migration20261023000000 adiciona o trigger statement-level de TRUNCATE. As duas são versionadas e reversíveis.

O script migrate aplica migrations pendentes; migration:down reverte apenas a mais recente. A suíte de integração verifica a aplicação, rollback e reaplicação em banco temporário, além de verificar explicitamente que TRUNCATE não apaga entradas do ledger.

## 15. Testes e validação observada

A suíte unitária cobre dinheiro, wallet, ledger, estados de transação, idempotência, eventos, inbox/outbox e o comportamento de shutdown do consumidor. A suíte de integração usa PostgreSQL e LocalStack reais no Docker Compose e cobre, entre outros casos:

- 50 submissões idênticas concorrentes e disputa de saldo;
- concorrência por wallet em HTTP e SQS e operação com três instâncias;
- idempotência, replay da resposta original e conflitos;
- regras de BET/WIN/LOSS/REFUND/ROLLBACK e referências fora de ordem;
- constraints, imutabilidade contra UPDATE/DELETE/TRUNCATE e rollback/reaplicação de migrations;
- rollback atômico quando a escrita na outbox falha;
- retry, DLQ e crash após commit antes do ACK;
- reinício do serviço com recuperação da outbox;
- overflow monetário e reconciliação após grande volume de ledger;
- contexto dos logs do publisher e métricas obrigatórias.

A execução bem-sucedida do workflow README requirement tests no commit de implementação 8ad99a2 registrou 51 testes unitários e 35 testes de integração. Isso é evidência de uma execução específica e não substitui a reexecução do CI após novas mudanças.

Comandos do host:

~~~bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
docker compose up --build -d
RUN_INTEGRATION=1 bun run test:integration
~~~

Para testes que injetam falhas, recrie a stack com ENABLE_TEST_FAULT_INJECTION=1 tanto na configuração do Compose quanto no comando de integração. Veja [README.md](README.md) para tutorial completo, comandos de operação e diagnóstico.

## 16. Correções recentes registradas

- **Ledger truncation:** corrigido pelo commit [7832e4f](https://github.com/joao-henrike/challenge/commit/7832e4f350ea14f3e4dc276ddce4b2beeac38d9d), com migration reversível que bloqueia TRUNCATE e teste de integração.
- **Contexto dos logs da outbox:** corrigido na implementação de OutboxPublisherService para extrair transactionId e demais identificadores dos dados reais do evento; há teste de integração para WalletBalanceChanged.
- **Rollback/reapply:** o teste confirma que as duas migrations são revertidas e reaplicadas e que ambos os triggers de imutabilidade existem após a reaplicação.

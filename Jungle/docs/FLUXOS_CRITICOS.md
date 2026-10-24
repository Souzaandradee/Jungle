# Guia de leitura dos fluxos críticos

Este documento explica como as partes essenciais do processador se conectam. A fonte dos requisitos funcionais continua sendo o [README oficial do desafio](https://github.com/junglegaming/backend-challenge/blob/main/README.md); este guia descreve a implementação atual, sem criar novos fluxos de negócio. Para stack, comandos de instalação, tutorial para subir todos os serviços e troubleshooting, consulte o [README do projeto](../README.md).

## Mapa rápido

| Responsabilidade | Onde começar | Papel principal |
| --- | --- | --- |
| Entrada HTTP e bootstrap | src/main.ts, src/app.module.ts | Configura validação, filtro de exceções, módulos, workers e controllers. |
| Dinheiro | src/domain/money.ts, src/domain/currency.ts | Representa dinheiro com Decimal; valida escala, moeda e limite. |
| Estado da wallet e ledger | src/domain/wallet.ts, src/domain/wallet-ledger-entry.ts | Aplica invariantes de saldo e valida aritmética do lançamento. |
| Regras de transação | src/domain/wager-transaction.ts, src/wagering/wagering.service.ts | Valida operação, referência e estado final. |
| Persistência e concorrência | src/wagering/wagering.service.ts, src/infra/database/sql.ts | Executa alteração financeira dentro de transação PostgreSQL. |
| Idempotência | src/domain/idempotency.ts, inbox_messages e wager_transactions | Reconhece reenvios sem duplicar efeitos financeiros. |
| Eventos e outbox | src/domain/events.ts, src/infra/database/outbox-writer.ts, src/infra/sqs/outbox-publisher.service.ts | Persiste eventos no mesmo commit da operação e publica depois. |
| Consumo SQS | src/infra/sqs/sqs-worker.service.ts, src/infra/sqs/sqs-client.service.ts | Valida mensagens e controla ACK, retry e DLQ. |
| Referências fora de ordem | src/wagering/pending-reference-worker.service.ts | Reprocessa transações pendentes quando a próxima tentativa vence. |
| Garantias no banco | migrations/ | Define constraints, índices e triggers de integridade/imutabilidade. |
| Operação | src/infra/logging/, src/infra/metrics/, src/health/ | Emite logs JSON, métricas e health checks. |

## 1. Caminho de uma transação via HTTP

1. WageringController valida a presença de Idempotency-Key e delega ao WageringService.
2. ValidationPipe e os DTOs rejeitam propriedades desconhecidas ou campos inválidos.
3. Money valida amount como string decimal com duas casas e currency segundo a allow-list.
4. WageringService calcula o hash canônico dos campos de negócio.
5. Uma transação PostgreSQL procura/inserta a transação com proteção de unicidade.
6. A wallet é bloqueada com FOR NO KEY UPDATE; o serviço verifica player, moeda, referência e saldo.
7. Se houver movimento financeiro, ledger e novo saldo são escritos na mesma transação.
8. O estado da transação e eventos na outbox são gravados antes do commit.
9. Após o commit, o serviço registra métricas/log e devolve o resultado. O controller converte os estados para 200, 202 ou 422.

Conflitos únicos são usados para resolver solicitações concorrentes. A chave Idempotency-Key não substitui a unicidade de (provider_id, external_transaction_id), e nenhuma garantia importante fica somente em memória.

## 2. Por que há domínio e SQL explícito

O domínio encapsula transições e aritmética. O SQL explícito torna auditáveis os pontos nos quais importam SELECT FOR UPDATE, ON CONFLICT, índices únicos, SKIP LOCKED, constraints e writes na mesma transação. MikroORM gerencia a conexão/transação e as migrations; os caminhos financeiros não dependem de uma Unit of Work genérica para tornar visível a ordem dos writes.

## 3. Dinheiro, saldo e ledger

### 3.1 Dinheiro

Money recebe e serializa strings com exatamente duas casas e permite no máximo 18 dígitos inteiros. Decimal é usado em toda a aritmética monetária. Formatos como string vazia, sinal negativo na entrada, notação científica, escala diferente de duas casas, não finitos ou valor fora do intervalo são rejeitados. O resultado aritmético pode ser negativo no domínio para representar uma diferença de reconciliação; contratos públicos não aceitam valores negativos.

A allow-list explícita em src/domain/currency.ts é repetida como regra de schema pela função is_iso4217_currency no PostgreSQL. Alterações na lista devem atualizar código, migration e testes juntos.

### 3.2 Regras de negócio por operação

| Operação | Pré-condição específica | Efeito se processada | Ledger | Evento de integração |
| --- | --- | --- | --- | --- |
| BET | A wallet pertence ao player, moeda compatível e saldo suficiente. | Subtrai da wallet. | Uma entrada DEBIT. | WagerTransactionProcessed e WalletBalanceChanged se o saldo mudar. |
| WIN | Se houver referência, deve ser uma BET processada do mesmo contexto. | Soma à wallet. | Uma entrada CREDIT. | WagerTransactionProcessed e WalletBalanceChanged se mudar o saldo. |
| LOSS | Validações gerais; não exige referência. | Registra resultado sem alterar saldo. | Nenhuma entrada. | WagerTransactionProcessed; não emite WalletBalanceChanged. |
| REFUND | Referência BET processada, mesmo contexto e valor; no máximo um refund processado por referência. | Credita o valor da aposta referenciada. | Uma entrada CREDIT. | WagerTransactionProcessed e WalletBalanceChanged se mudar o saldo. |
| ROLLBACK | Referência BET, WIN ou REFUND processada, mesmo contexto/valor e ainda não revertida por rollback. | Inverte a direção do lançamento referenciado. | Uma entrada na direção inversa. | WagerTransactionProcessed e WalletBalanceChanged se mudar o saldo. |

OPENING é interno: não pode ser submetido como operação externa. Quando uma wallet nasce com saldo positivo, criação da wallet, transação OPENING, crédito no ledger e eventos relacionados são atômicos. Saldo inicial zero não produz lançamento financeiro.

### 3.3 Garantias no banco

- Uma wallet por (player_id, currency).
- idempotency_key e (provider_id, external_transaction_id) únicos.
- Saldo e valores de ledger não negativos; códigos de moeda precisam estar na allow-list.
- No máximo um lançamento por transaction_id.
- Aritmética do ledger validada por ledger_arithmetic_ck.
- No máximo uma reversão processada de cada tipo por reference_transaction_id.
- inbox_messages usa chave primária (consumer_name, message_id).
- Trigger wallet_ledger_immutable_trg bloqueia UPDATE/DELETE.
- Trigger wallet_ledger_no_truncate_trg bloqueia TRUNCATE.

### 3.4 Imutabilidade do ledger: correção concluída

O primeiro trigger bloqueava UPDATE e DELETE por linha, mas isso não intercepta TRUNCATE, que é uma operação de statement. A correção foi implementada em migrations/Migration20261023000000.ts como trigger BEFORE TRUNCATE ... FOR EACH STATEMENT, utilizando a mesma função que rejeita mutações.

A suíte integrada tenta executar TRUNCATE dentro de uma transação de teste e verifica que a operação falha e que o lançamento da wallet permanece no ledger. Também testa rollback e reaplicação das migrations e confirma a presença dos dois triggers.

Referência: commit [7832e4f — fix: prevent truncation of immutable wallet ledger](https://github.com/joao-henrike/challenge/commit/7832e4f350ea14f3e4dc276ddce4b2beeac38d9d).

## 4. Idempotência e inbox

Há duas proteções relacionadas, mas com propósitos distintos:

- **Idempotência de negócio:** Idempotency-Key identifica a intenção submetida. SHA-256 é calculado sobre JSON canônico dos campos de negócio normalizados; chaves de objeto são ordenadas e metadados de transporte ficam de fora. Payload igual devolve resultado persistido e saldo original; payload diferente com a mesma chave resulta em 409.
- **Deduplicação de mensagem:** inbox_messages usa (consumer_name, message_id) como chave persistente. O registro é escrito junto com os efeitos financeiros. Redelivery da mesma mensagem não aplica novamente o débito/crédito.

As constraints protegem os identificadores mesmo quando duas instâncias observam os mesmos dados concorrencialmente. Inbox com a mesma messageId mas payloadHash diferente é conflito, não replay válido.

## 5. Inbox, SQS, retry e DLQ

SqsWorkerService valida o envelope, horário, tipo e campos da mensagem antes de chamar o caso de uso compartilhado. Mensagens do mesmo MessageGroupId são processadas sequencialmente dentro do batch; grupos distintos podem avançar em paralelo.

- Rejeições de negócio persistidas são terminais e podem receber ACK.
- Falhas transitórias recebem mudança de visibility timeout/backoff e retries limitados.
- Payload inválido e falha permanente vão para DLQ quando configurada.
- A mensagem original só é apagada depois de confirmado o envio à DLQ; se o envio falhar, ela continua elegível a retry.
- O ACK da mensagem de entrada só acontece depois do commit que inclui a inbox.
- Em shutdown, o worker aguarda a mensagem ativa e devolve visibilidade das mensagens que ainda não começaram.

A fila configurada no Compose usa redrive policy de segurança com limite de recebimentos. ENABLE_TEST_FAULT_INJECTION é opt-in para permitir testes deliberados de falha transitória e crash após commit/antes do ACK. Não habilite injeção de falhas em produção.

## 6. Outbox e eventos de integração

O caso de uso cria envelopes versionados com eventId, eventType, aggregateId, correlationId, causationId opcional, occurredAt, version e data. Valores monetários em eventos são strings com duas casas.

1. O evento é persistido em outbox_messages no mesmo commit da operação financeira.
2. OutboxPublisherService seleciona pendências com FOR UPDATE SKIP LOCKED.
3. O publisher envia o evento à fila SQS e marca published_at depois do sucesso.
4. Falha de envio incrementa attempts e calcula next_attempt_at com backoff.

É possível publicar um duplicado se SQS aceitar o envio e o processo falhar antes de confirmar a marcação no banco. Isso é at-least-once, não exactly-once. Consumidores devem deduplicar por eventId.

### 6.1 Contexto correto nos logs de outbox: correção concluída

aggregate_id identifica o agregado do evento e pode ser uma wallet, não uma transação. O logger do publisher agora deriva transactionId, walletId e providerId de payload.data quando esses campos existem; correlationId vem do envelope e messageId representa o eventId/identificador estável. O código não deve inferir transactionId a partir de aggregateId.

Há teste integrado que verifica os campos do log de WalletBalanceChanged e confirma que transactionId corresponde à transação OPENING real.

Referência: implementação atual em [outbox-publisher.service.ts](../src/infra/sqs/outbox-publisher.service.ts).

### 6.2 Limitação de ordenação

FOR UPDATE SKIP LOCKED coordena publishers para que não reivindiquem a mesma linha ao mesmo tempo, mas não garante ordem estrita de publicação de eventos diferentes do mesmo aggregate_id. Publishers concorrentes podem enviar um evento de versão posterior antes de um anterior. SQS FIFO mantém ordem de chegada para cada grupo, não a ordem original de inserção no PostgreSQL quando produtores concorrem.

Os testes atuais verificam entrega dos eventos por múltiplos publishers; não comprovam ordenação estrita de alterações de saldo do mesmo agregado. Consumidores devem tolerar duplicados e interpretar eventId/version e walletVersion. Caso a ordem estrita seja requisito, introduza serialização explícita por agregado e testes que confirmem sequência de versão.

## 7. Estados pendentes e referências fora de ordem

Para WIN com referência, REFUND e ROLLBACK, a referência é procurada por provedor e identificador externo.

1. Referência ausente ou ainda PENDING/PENDING_REFERENCE: a transação pode ficar PENDING_REFERENCE e tenta novamente sem alterar saldo/ledger.
2. Referência existente mas não PROCESSED: rejeita com REFERENCE_NOT_PROCESSED.
3. Referência processada, mas incompatível em tipo, jogador, wallet, moeda, rodada, valor ou reversão anterior: rejeita com failureCode específico.

O worker busca candidatos vencidos no banco. WageringService.processPendingReference bloqueia a linha com FOR UPDATE SKIP LOCKED, redefine o estado para PENDING dentro da transação e reexecuta as regras de negócio. O limite é dez tentativas; o backoff exponencial vai de 1 segundo até 60 segundos. No limite, a transação termina REJECTED com REFERENCE_NOT_FOUND e evento de rejeição.

## 8. Eventos, logs e métricas

StructuredLogger emite JSON com timestamp, level, message e contexto: correlationId, messageId, transactionId, walletId e providerId. Não registra o payload financeiro completo. ApiExceptionFilter preserva respostas explícitas do domínio e devolve resposta genérica em erro inesperado; falhas transitórias reconhecidas podem ser mapeadas para 503.

MetricsService mantém métricas de:
- transações por status;
- duplicatas detectadas;
- retries por origem;
- contagem aproximada de mensagens visíveis na DLQ;
- deadlocks/serialization conflicts;
- idade do evento mais antigo pendente na outbox;
- latência de processamento;
- divergências de reconciliação.

/health/live não acessa dependências. /health/ready testa PostgreSQL e as três filas configuradas. /metrics expõe Prometheus.

## 9. Migrations e reversão

Migration20261022000000 cria o schema principal, índices, constraints, inbox/outbox e trigger de imutabilidade UPDATE/DELETE. Migration20261023000000 adiciona o bloqueio de TRUNCATE. Ambas têm método down.

migration:down reverte apenas a migration mais recente. O teste de integração cria um banco temporário, aplica ambas, reverte a mais nova e a inicial, verifica remoção das tabelas e reaplica; depois verifica que as tabelas e os dois triggers voltaram a existir. Não execute rollback manual da migration inicial em dados que precisam ser preservados.

## 10. Outras limitações explícitas

- A autenticação externa é um ponto de extensão no-op, conforme permitido pelo desafio; não é uma proteção de identidade pronta para produção.
- A entrega de eventos é pelo menos uma vez e pode produzir duplicados.
- O Compose usa credenciais e senhas locais de teste. Implantação real deve usar IAM Roles/cadeia padrão de credenciais e segredos apropriados.
- Os triggers protegem operações normais de mutação; administradores com privilégios suficientes ainda podem alterar schema, desabilitar triggers ou modificar o banco. A conta de aplicação em produção deve ter privilégios mínimos.
- A ordenação estrita de eventos por agregado entre publishers concorrentes ainda requer validação/serialização adicional se for requisito operacional.

## 11. Validação e tutorial

Tutorial completo de pré-requisitos, clone/checkout, ambiente, startup, health checks, exemplos HTTP, chamadas SQS, métricas, migrations, testes, reset e troubleshooting: [README.md](../README.md).

Comandos principais a partir da raiz:

~~~bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
docker compose up --build -d
RUN_INTEGRATION=1 bun run test:integration
~~~

A execução bem-sucedida do workflow README requirement tests no commit de implementação 8ad99a2 reportou 51 testes unitários e 35 testes de integração. Os valores descrevem aquela execução específica; reexecute CI após mudanças.

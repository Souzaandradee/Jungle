# Relatório Técnico — Distributed Wagering Processor

**Repositório:** [joao-henrike/challenge](https://github.com/joao-henrike/challenge)  
**Branch de referência:** main  
**Data da documentação:** 24 de outubro de 2026  
**Escopo:** arquitetura, decisões de implementação, integridade financeira, processamento assíncrono, testes, operação e limitações conhecidas.

> Este relatório registra o racional técnico da solução implementada no repositório. Ele distingue mecanismos existentes, decisões de desenho e melhorias recomendadas; não deve ser lido como afirmação de que todos os requisitos de produção já estão atendidos.

## 1. Resumo executivo

O Distributed Wagering Processor é um backend em TypeScript para processar transações de apostas recebidas por HTTP ou por Amazon SQS. O sistema mantém saldos de carteiras, registra os movimentos em um ledger financeiro auditável e publica eventos de integração a partir de uma transactional outbox.

A decisão central foi manter **um único backend NestJS**, com regras de negócio compartilhadas entre as entradas HTTP e SQS, usando o **PostgreSQL como autoridade dos dados financeiros**. A concorrência, a idempotência, a consistência do ledger e a recuperação de falhas são protegidas por uma combinação de transações SQL, locks, constraints, índices únicos, inbox/outbox persistentes e retries controlados. A configuração local sobe três instâncias da mesma API para permitir testes de concorrência entre processos, sem transformar o projeto em uma arquitetura de microserviços independentes.

O desenho procura equilibrar simplicidade, verificabilidade e robustez. A correção financeira é garantida principalmente na fronteira transacional do banco, não por estado temporário na memória de um processo.

## 2. Objetivo, escopo e premissas

A especificação funcional de referência é o [README original do desafio Jungle Gaming](https://github.com/junglegaming/backend-challenge). As decisões que a especificação deixa sob responsabilidade da implementação estão documentadas em [ARCHITECTURE.md](ARCHITECTURE.md), enquanto [docs/FLUXOS_CRITICOS.md](docs/FLUXOS_CRITICOS.md) apresenta um mapa dos principais caminhos de execução.

O sistema cobre:

- criação e consulta de carteiras (wallets);
- submissão e consulta de transações de apostas;
- operações BET, WIN, LOSS, REFUND e ROLLBACK;
- idempotência de chamadas HTTP e deduplicação de mensagens SQS;
- ledger de movimentos financeiros e reconciliação de saldo;
- emissão assíncrona de eventos com transactional outbox;
- processamento de mensagens, retry, dead-letter queue (DLQ) e referências fora de ordem;
- health checks, logs estruturados e métricas Prometheus;
- testes unitários, de integração, concorrência e recuperação de falhas.

A execução local usa PostgreSQL e LocalStack como dependências reais em containers. LocalStack emula SQS para permitir desenvolvimento e testes sem depender de uma conta AWS. As credenciais, senhas e endpoints locais são valores de desenvolvimento, não uma configuração de produção.

## 3. Princípios de engenharia adotados

### 3.1 KISS e um único caso de uso financeiro

O projeto usa uma aplicação NestJS única, organizada por domínio, serviços e infraestrutura. HTTP e SQS convergem para o mesmo caso de uso de processamento de transações. Isso evita manter duas implementações financeiras paralelas, que poderiam evoluir de formas diferentes e aplicar regras incompatíveis.

Não foram criados microserviços independentes, um event bus em memória ou um cache de negócio. Esses elementos aumentariam a superfície operacional e não são necessários para demonstrar as invariantes exigidas pelo desafio.

### 3.2 O banco como autoridade de consistência

O PostgreSQL é a fonte de verdade dos saldos, das transações, do ledger, da inbox e da outbox. Estruturas em memória podem validar e calcular operações, mas não coordenam a correção entre múltiplas instâncias. A proteção contra concorrência e duplicação depende de transações e garantias persistentes que funcionam mesmo quando requisições são atendidas por processos diferentes.

### 3.3 SQL explícito nos caminhos críticos

MikroORM é usado para conexão, transações e migrations. SQL explícito foi mantido nos caminhos em que a ordem das operações, o lock adquirido, a condição de atualização ou a constraint utilizada precisam ficar claros para auditoria. A intenção é tornar verificável a sequência de leitura, validação e escrita do saldo, em vez de esconder a concorrência atrás de abstrações genéricas.

### 3.4 Falhas são parte do desenho

O sistema considera que mensagens podem ser redeliveradas, processos podem cair após um commit, referências podem chegar fora de ordem, um publisher pode falhar e uma dependência pode ficar indisponível. Por isso, o desenho utiliza registros persistentes, políticas de retry, DLQ e testes que exercitam falhas controladas. Não se presume execução exactly-once entre banco e broker.

## 4. Stack e responsabilidades

| Tecnologia | Responsabilidade e razão de uso |
|---|---|
| Bun 1.x | Runtime, instalação de dependências e test runner. |
| TypeScript em modo strict | Tipagem estática dos contratos e componentes. |
| NestJS 10 | Aplicação HTTP, controllers, módulos e injeção de dependências. |
| MikroORM 6 | Integração com PostgreSQL, transações e migrations. |
| PostgreSQL 17 | Persistência transacional, concorrência, integridade referencial e constraints financeiras. |
| decimal.js | Aritmética monetária decimal sem depender de ponto flutuante binário. |
| AWS SDK for JavaScript v3 | Integração com SQS. |
| LocalStack 4 | Emulação local de SQS. |
| class-validator e class-transformer | Validação e transformação de DTOs. |
| prom-client | Métricas de aplicação no formato Prometheus. |
| Docker Compose | Ambiente local reproduzível com banco, filas, migration e réplicas da API. |
| GitHub Actions | Verificação automatizada de instalação, typecheck, build e testes. |

As versões e dependências JavaScript estão declaradas em [package.json](package.json) e [bun.lock](bun.lock). A topologia local está definida em [docker-compose.yml](docker-compose.yml).

## 5. Organização do código

A separação por responsabilidade foi usada para manter regras financeiras distinguíveis dos detalhes de transporte e persistência:

- **src/domain:** tipos e regras centrais, incluindo Money, Wallet, WagerTransaction, WalletLedgerEntry, idempotência e envelopes de eventos.
- **src/wallets:** criação e consulta de wallets, paginação do ledger e reconciliação.
- **src/wagering:** submissão de transações, aplicação das regras de negócio e reprocessamento de referências pendentes.
- **src/infra/database:** configuração do banco, execução de SQL, persistência da outbox e mappings necessários.
- **src/infra/sqs:** cliente SQS, worker consumidor e publisher da outbox.
- **src/infra/logging:** logs JSON e filtro global de exceções.
- **src/infra/metrics:** métricas operacionais.
- **src/health:** liveness e readiness.
- **migrations:** schema versionado, constraints, índices e triggers.
- **test/unit e test/integration:** testes isolados e testes com dependências reais.

O princípio prático é manter o domínio responsável pelas invariantes locais e o PostgreSQL responsável pelas garantias transacionais compartilhadas. Controllers e workers não devem implementar regras financeiras próprias.

## 6. Representação exata de dinheiro

Valores monetários são recebidos como strings com exatamente duas casas decimais, por exemplo 25.00, e convertidos para Decimal. O código evita usar o tipo number para cálculos financeiros, pois a representação binária de ponto flutuante pode produzir diferenças de arredondamento.

O domínio limita os valores a 999999999999999999.99, compatível com a precisão de numeric(20,2). A serialização mantém duas casas decimais. A moeda é validada por uma lista explícita no domínio e a restrição equivalente também existe no banco, evitando que a aceitação de moedas dependa apenas do comportamento de um runtime.

Money é imutável e as operações verificam a compatibilidade de moeda. Valores monetários expostos em contratos são não negativos; internamente, a representação de diferenças assinadas é útil para o cálculo da reconciliação.

A lista de moedas é uma decisão explícita do repositório. Atualizá-la exige alinhar domínio, DTOs, migrations e testes, para não permitir que a camada HTTP e o banco aceitem conjuntos diferentes.

## 7. Modelo de dados e invariantes financeiras

As principais estruturas persistentes são:

- **wallets:** saldo materializado, identidade do jogador, moeda e versão da carteira;
- **wager_transactions:** identidade externa, chave idempotente, hash do payload, estado, referência e resposta persistida;
- **wallet_ledger_entries:** movimentos de crédito e débito com saldo anterior e posterior;
- **inbox_messages:** mensagens SQS já recebidas/processadas, com identidade e controle de duplicação;
- **outbox_messages:** eventos que precisam ser publicados depois do commit financeiro.

### 7.1 Saldo e ledger são escritos juntos

Quando uma transação altera saldo, a atualização da wallet, a inserção no ledger, a atualização do estado da transação e a gravação dos eventos de outbox pertencem à mesma transação PostgreSQL. Se uma escrita crítica falhar, a operação financeira deve ser revertida como conjunto, em vez de deixar saldo sem lançamento ou lançamento sem saldo correspondente.

Uma transação pode criar no máximo uma entrada no ledger, protegida por unicidade em transaction_id. Uma operação LOSS não movimenta dinheiro e não gera entrada no ledger. Rejeições por regras de negócio também não geram lançamento financeiro. A abertura de uma wallet com saldo inicial positivo gera uma transação OPENING e um crédito inicial auditável.

### 7.2 Integridade aritmética no banco

O ledger conserva direction, amount, balance_before e balance_after. A constraint ledger_arithmetic_ck verifica que o resultado aritmético corresponde à direção:

- DEBIT: balance_after = balance_before - amount;
- CREDIT: balance_after = balance_before + amount.

Constraints adicionais protegem unicidade, referências e limites relevantes. As garantias no banco reduzem a dependência de que todos os caminhos de execução estejam perfeitamente implementados na aplicação.

### 7.3 Imutabilidade do ledger

O ledger é projetado como registro de auditoria, não como uma tabela de saldos editáveis. A migration inicial cria um trigger que bloqueia UPDATE e DELETE; uma migration adicional, Migration20261023000000, bloqueia TRUNCATE por trigger a nível de statement. Essa segunda proteção é importante porque TRUNCATE não dispara triggers convencionais por linha.

Esses mecanismos protegem contra operações comuns executadas por uma conta de aplicação sem privilégios elevados. Eles não substituem segregação de privilégios: um administrador com permissões suficientes ainda pode alterar o schema ou desativar proteções.

### 7.4 Reconciliação

A reconciliação compara o saldo armazenado na wallet com a soma líquida do ledger. A leitura usa um único statement SQL para evitar comparar o saldo e os lançamentos em snapshots distintos durante atividade concorrente. Uma divergência é informada, registrada em log e contabilizada em métrica; a aplicação não ajusta silenciosamente o saldo para esconder a inconsistência.

## 8. Concorrência entre transações

Antes de validar e alterar uma wallet, o serviço adquire um lock de linha PostgreSQL usando SELECT ... FOR NO KEY UPDATE. Isso serializa modificações da mesma carteira: duas apostas concorrentes não devem aprovar seus débitos com base no mesmo saldo inicial. Wallets diferentes podem avançar em paralelo porque não compartilham um lock global em memória.

A versão da wallet avança quando o saldo muda. O update condicionado à versão reforça a consistência e torna explícita a expectativa de que a linha lida é a mesma que será atualizada.

A estratégia evita um mutex apenas local: esse mutex não coordenaria api, api-2 e api-3, nem sobreviveria a reinícios. SQS FIFO e MessageGroupId ajudam na ordenação de mensagens, mas não substituem a serialização transacional no banco.

## 9. Idempotência e prevenção de efeitos duplicados

A idempotência opera em mais de uma fronteira, pois uma chamada HTTP repetida e uma mensagem SQS redeliverada são duplicações diferentes.

### 9.1 HTTP

O header Idempotency-Key é obrigatório. O payload de negócio é normalizado e transformado em JSON canônico — com chaves de objetos em ordem estável — e recebe um hash SHA-256.

- Mesma chave e mesmo hash: a aplicação devolve o resultado persistido, marcado como replay idempotente, sem novo efeito financeiro.
- Mesma chave com payload de negócio divergente: conflito HTTP 409.
- Mesmo par provider_id e external_transaction_id já utilizado: conflito protegido por índice único no banco.

A resposta e o saldo associados à transação são persistidos para evitar que um replay responda com um saldo atual diferente daquele que foi produzido pela operação original.

### 9.2 SQS e inbox

A inbox identifica a mensagem pelo par consumer_name e message_id. Seu registro, a transação financeira e os efeitos persistentes participam do mesmo commit. Se o processamento confirmar no banco e o processo cair antes de enviar o ACK à SQS, a redelivery posterior será reconhecida pela inbox/idempotência em vez de reaplicar o débito.

Essa combinação evita depender da memória de uma instância para lembrar que uma operação já foi executada.

## 10. Regras das operações e referências

As operações cobrem os seguintes efeitos principais:

| Tipo | Efeito no saldo | Condições centrais |
|---|---|---|
| BET | Débito | Exige saldo suficiente; caso contrário, rejeita com INSUFFICIENT_FUNDS. |
| WIN | Crédito | A referência é opcional; quando informada, deve identificar uma BET processada do mesmo contexto. |
| LOSS | Nenhum | Registra o resultado como processado sem lançamento financeiro. |
| REFUND | Crédito | Exige referência a BET processada, mesmo contexto e mesmo valor; apenas um REFUND processado por referência. |
| ROLLBACK | Inverte a direção do lançamento referenciado | Exige referência processada a BET, WIN ou REFUND, mesmo contexto e mesmo valor; apenas um ROLLBACK processado por referência. |

As regras de contexto verificam provedor, jogador, wallet, moeda e rodada, conforme o tipo da referência. Índices únicos parciais complementam as verificações da aplicação para proteger a regra de uma única reversão processada mesmo sob concorrência.

Se uma reversão por débito não puder ser aplicada por saldo insuficiente, a operação é rejeitada com código de falha estável, sem criar um lançamento parcial. As rejeições permanecem consultáveis e auditáveis.

### 10.1 Referências fora de ordem

WIN com referência fornecida, REFUND e ROLLBACK podem depender de uma transação que ainda não chegou ou ainda está pendente. Nesses casos, a aplicação registra PENDING_REFERENCE, guarda a próxima tentativa elegível e grava um evento correspondente na outbox. Um worker busca as tentativas vencidas e bloqueia a linha com FOR UPDATE SKIP LOCKED antes de reprocessá-la.

O backoff cresce de 1 segundo até 60 segundos, com limite de dez tentativas. Ao esgotar as tentativas, a transação termina rejeitada com REFERENCE_NOT_FOUND. As regras de negócio são revalidadas a cada tentativa; o worker não presume que a referência finalmente recebida seja válida só porque existe.

## 11. SQS, retries e dead-letter queue

O ambiente local cria três filas:

- **wager-transactions.fifo:** entrada de transações;
- **wager-transactions-dlq.fifo:** mensagens que não puderam ser processadas com segurança;
- **wager-events.fifo:** destino local dos eventos originados na outbox.

O worker valida o envelope, os campos de negócio e o tipo da operação antes de delegar ao mesmo caso de uso utilizado por HTTP. O ACK só acontece depois que o processamento persistente termina. Uma rejeição de negócio que foi gravada é um resultado terminal e não deve ser repetida indefinidamente.

Falhas transitórias seguem um backoff limitado e têm limite de recebimentos tratados pela aplicação. Mensagens inválidas ou falhas permanentes são encaminhadas à DLQ. A mensagem de origem não é removida antes que o envio à DLQ seja confirmado; se o envio falhar, a mensagem é mantida para nova tentativa. Em encerramento do processo, o worker espera a operação ativa e devolve a visibilidade das mensagens que ainda não começaram a ser processadas.

A variável ENABLE_TEST_FAULT_INJECTION é opt-in e permite simular cenários de falha em testes. Deve permanecer desativada no uso normal.

## 12. Transactional outbox e entrega de eventos

A outbox resolve o problema de dual write: gravar dados financeiros no PostgreSQL e publicar um evento no broker são duas operações independentes, e uma poderia ter sucesso sem a outra. Por isso, o evento é armazenado na outbox dentro da mesma transação financeira. Um publisher independente tenta enviá-lo à SQS depois do commit e marca published_at somente depois de o envio ser confirmado.

A reivindicação de pendências usa FOR UPDATE SKIP LOCKED para permitir que publishers em instâncias diferentes trabalhem sem selecionar ao mesmo tempo a mesma linha. Falhas são registradas e recebem nova tentativa; o evento continua persistido.

### 12.1 Por que a entrega é at-least-once

Existe uma janela inevitável sem transação distribuída entre PostgreSQL e SQS: o broker pode aceitar a mensagem e o processo pode falhar antes de gravar published_at. Nesse caso, o publisher pode enviar o mesmo evento novamente. Portanto, a garantia é **at-least-once**, e não exactly-once. Cada envelope inclui um eventId estável para que consumidores possam deduplicar.

### 12.2 Ordenação dos eventos

SKIP LOCKED coordena a reivindicação de registros, mas não garante ordem estrita de publicação de eventos diferentes do mesmo agregado quando vários publishers estão ativos. SQS FIFO preserva a ordem de chegada dentro do grupo, mas publishers concorrentes ainda podem enviar em ordem diferente da criação original. Consumidores devem deduplicar por eventId e considerar version/walletVersion. Se a ordem estrita por agregado for requisito de negócio, será necessária uma estratégia explícita de serialização e testes específicos.

## 13. API HTTP

As rotas principais são:

| Método | Endpoint | Finalidade |
|---|---|---|
| POST | /wallets | Criar wallet e, quando há saldo inicial positivo, registrar OPENING e ledger. |
| GET | /wallets/:walletId | Consultar carteira, saldo e versão. |
| GET | /wallets/:walletId/ledger?cursor=...&limit=50 | Consultar lançamentos com paginação por cursor. |
| POST | /wallets/:walletId/reconciliation | Comparar saldo materializado com o ledger. |
| POST | /wagering/transactions | Submeter operação; exige Idempotency-Key. |
| GET | /wagering/transactions/:transactionId | Consultar transação pelo identificador interno. |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId | Consultar transação pela identidade externa do provedor. |
| GET | /health/live | Verificar se o processo responde. |
| GET | /health/ready | Verificar disponibilidade das dependências críticas. |
| GET | /metrics | Expor métricas Prometheus. |

O contrato distingue payload inválido, recurso inexistente, conflito de idempotência, rejeição de negócio e falha transitória. Em linhas gerais, 200 indica operação processada ou replay; 202 indica espera por referência; 400 indica entrada inválida; 404 indica recurso inexistente; 409 indica conflito de identidade/idempotência; 422 indica rejeição de regra de negócio com failureCode; 503 indica indisponibilidade transitória reconhecida.

A paginação por cursor permite percorrer o ledger de forma mais estável do que deslocamentos por offset em um histórico que cresce continuamente.

## 14. Observabilidade e diagnóstico

Os logs são JSON estruturado, com timestamp, nível, mensagem e campos contextuais como correlationId, messageId, transactionId, walletId e providerId, quando aplicáveis. O contexto é derivado de dados reais da operação ou do evento. Por exemplo, aggregateId não é presumido como transactionId, pois o agregado pode ser uma wallet.

O serviço de métricas expõe famílias como:

- wager_transactions_total;
- wager_idempotent_duplicates_total;
- wager_retries_total;
- wager_dlq_messages;
- wager_lock_conflicts_total;
- wager_outbox_lag_seconds;
- wager_processing_latency_seconds;
- wager_reconciliation_mismatches_total.

Liveness indica que o processo está respondendo. Readiness verifica PostgreSQL e as filas críticas. Essa distinção facilita diagnosticar um processo que está ativo, mas não consegue atender solicitações com segurança.

A reconciliação não corrige silenciosamente divergências. Ela produz evidência operacional por retorno, log e métrica, permitindo investigação da causa antes de qualquer ajuste.

## 15. Schema, migrations e evolução

As migrations versionam o schema e suas invariantes. A migration Migration20261022000000 cria as tabelas centrais, constraints, índices, estruturas de inbox/outbox e proteção por trigger contra UPDATE/DELETE no ledger. A migration Migration20261023000000 acrescenta a proteção de TRUNCATE.

A migração reversível facilita verificar a sequência de aplicação e rollback em ambiente de desenvolvimento. Os testes de integração usam um banco temporário para aplicar, reverter e reaplicar migrations e inspecionar os triggers resultantes. Rollback de migrations sobre uma base com dados reais não deve ser tratado como procedimento rotineiro de produção: a migration inicial remove estruturas essenciais ao ser revertida.

## 16. Testes e validação

O projeto separa testes unitários de testes de integração.

Os testes unitários cobrem domínio, dinheiro, carteiras, ledger, estados de transação, idempotência, eventos e comportamento de workers. Os testes de integração usam PostgreSQL e LocalStack reais em containers para exercitar concorrência, persistência, filas, migrations e falhas que não seriam reproduzidas por mocks isolados.

A cobertura documentada inclui:

- dezenas de requisições idênticas concorrentes sem débito duplicado;
- duas apostas disputando o mesmo saldo;
- operação em múltiplas instâncias HTTP e SQS;
- replays idempotentes e conflitos por payload divergente;
- regras e referências de BET, WIN, LOSS, REFUND e ROLLBACK;
- constraints, imutabilidade de UPDATE/DELETE/TRUNCATE e reconciliação;
- rollback atômico diante de falha de escrita na outbox;
- retry, DLQ e crash entre commit e ACK;
- recuperação após reinício de serviço;
- rollback e reaplicação de migrations;
- contexto dos logs e métricas obrigatórias.

O workflow [README requirement tests](.github/workflows/readme-tests.yml) instala dependências com lockfile congelado, faz typecheck e build, executa testes unitários, sobe os containers para integração, espera a readiness das três APIs e executa a suíte de integração. Ele também coleta logs quando há falha e encerra o ambiente ao final. A execução associada ao commit da branch antes do merge retornou sucesso; novas alterações devem continuar sendo validadas pelo CI e, quando pertinente, por teste local.

## 17. Containers e execução local

O Compose define PostgreSQL 17, LocalStack, um serviço de migration e três instâncias da API nas portas 3000, 3001 e 3002. Health checks e dependências condicionais evitam iniciar as APIs antes de o banco e as filas estarem prontos e de a migration terminar.

O modo completo é útil para testar concorrência entre instâncias, mas não é a melhor primeira execução em um host com recursos limitados: o build inicial baixa imagens e dependências e pode concorrer por CPU e memória. Por isso, o README documenta um modo de desenvolvimento conservador com uma única API, limites opcionais de recursos para os containers e build sequencial. Esses limites de execução não restringem diretamente o consumo de memória do processo de build; se o host congelar, não se deve repetir a compilação sem investigar memória, disco e logs.

Os volumes postgres_data e localstack_data preservam dados locais. O comando docker compose down para e remove containers/rede sem apagar volumes; docker compose down -v é destrutivo para esses dados e só deve ser usado quando a intenção for reiniciar a base local do zero.

## 18. Segurança, trade-offs e limitações conhecidas

### 18.1 Identidade de provedor

A autenticação real não foi implementada porque o escopo do desafio permite deixá-la como ponto de extensão. O repositório fornece um adapter no-op, mas ele não autentica nem autoriza de verdade. Uma implantação real que exija identidade de provedor deve integrar um IdP, definir autorização e testar os limites de confiança; a presença de uma interface de extensão não equivale à existência de segurança de produção.

### 18.2 Credenciais e privilégios

As chaves AWS de teste e as senhas no Compose são exclusivamente locais. A configuração atual do cliente SQS contém credenciais explícitas e fallback para valores de teste; antes de executar na AWS com IAM Roles, o cliente deve ser ajustado para só fornecer credenciais explícitas quando configuradas e, caso contrário, permitir a cadeia padrão do SDK. A conta de banco usada em produção também deve ter privilégios mínimos, sem permissão para alterar schema ou desabilitar triggers.

### 18.3 Build reprodutível

O Dockerfile atual executa a instalação antes de copiar bun.lock para a imagem e não usa bun install --frozen-lockfile dentro do build. CI e instalação local podem, portanto, seguir o lockfile enquanto a imagem resolve as dependências sem a mesma garantia explícita. A correção recomendada é copiar package.json e bun.lock antes da instalação e usar instalação congelada também na imagem.

### 18.4 Entrega e ordem dos eventos

A outbox garante persistência do evento junto da operação financeira e recuperação de tentativas, mas não transforma o banco e SQS em uma única transação distribuída. Duplicação de publicação é possível e deve ser suportada pelos consumidores. A ordenação estrita por agregado também não é garantida pela concorrência de publishers atual; caso se torne necessária, precisa de desenho e testes específicos.

### 18.5 Produção

A configuração do Compose foi elaborada para desenvolvimento e teste, não para produção endurecida. Uma implantação real exige, no mínimo, autenticação/autorização, gestão de segredos, IAM, rede e privilégios restritos, políticas de backup/restauração, monitoramento e alertas, gestão de capacidade, estratégia de retenção, validação de ordenação/deduplicação dos consumidores e um procedimento operacional para reconciliar divergências.

## 19. Decisões e alternativas consideradas

| Decisão adotada | Motivo técnico | Custo/limitação assumida |
|---|---|---|
| Uma aplicação NestJS, vários adapters de entrada | Mantém regras HTTP/SQS compartilhadas e reduz complexidade operacional. | Um deploy contém API e workers; escala independente exigiria separar processos/configuração. |
| PostgreSQL como fonte de verdade | Transações, locks e constraints são a autoridade da consistência financeira. | Exige desenhar consultas e transações críticas cuidadosamente. |
| Decimal e string nos contratos monetários | Evita erro de ponto flutuante e mantém precisão explícita. | Requer validar formato e serialização; não usar number para cálculos monetários. |
| Idempotência persistente + inbox | Controla replays HTTP e redelivery SQS em diferentes fronteiras. | Exige retenção e índices apropriados para o volume real. |
| Ledger imutável com reconciliação | Mantém trilha auditável e permite detectar inconsistências. | A reconciliação detecta, mas não corrige; precisa de procedimento operacional. |
| Transactional outbox | Evita perder o evento se a transação financeira confirmar e a publicação falhar. | Entrega at-least-once, deduplicação do consumidor e estratégia de ordenação continuam importantes. |
| LocalStack e Compose | Permite testar dependências e fluxos de ponta a ponta em ambiente local. | A emulação não substitui testes de integração, permissões e comportamento em AWS real. |
| Três réplicas no teste local | Exercita concorrência entre processos e dependência de coordenação no banco. | A topologia completa pode consumir recursos significativos no computador do desenvolvedor. |

## 20. Prioridades técnicas recomendadas

Antes de uma implantação que vá além do desafio, as prioridades são:

1. Corrigir o Dockerfile para instalar dependências com bun.lock e modo congelado, garantindo builds reproduzíveis.
2. Substituir o adapter de identidade no-op por autenticação e autorização reais, se a implantação exigir identidade de provedor.
3. Remover o fallback de credenciais explícitas de teste do cliente SQS em ambientes que devem usar IAM Roles.
4. Definir e testar explicitamente a política de ordenação dos eventos por agregado, caso consumidores dependam de ordem estrita.
5. Definir políticas de retenção para inbox/outbox e chaves de idempotência conforme o volume e o SLA reais.
6. Criar operação de backup, restore, alertas, gestão de segredos, privilégio mínimo e resposta a divergências de reconciliação.
7. Executar o conjunto completo de CI após alterações relevantes e testar a implantação no ambiente-alvo, sem assumir que sucesso local garante comportamento idêntico na nuvem.

## 21. Referências do repositório

- [README de instalação, execução e troubleshooting](README.md)
- [Decisões de arquitetura](ARCHITECTURE.md)
- [Guia dos fluxos críticos](docs/FLUXOS_CRITICOS.md)
- [Compose local](docker-compose.yml)
- [Workflow de testes de integração](.github/workflows/readme-tests.yml)
- [Pull request que integrou a implementação à main](https://github.com/joao-henrike/challenge/pull/2)
- [Commit que atualizou a documentação do README](https://github.com/joao-henrike/challenge/commit/4cc98672e1867d7e93c192f00f59c33a348985ca)
- [Especificação original do desafio](https://github.com/junglegaming/backend-challenge)

---

## Conclusão

A solução foi construída para tornar explícita a relação entre consistência financeira, concorrência e recuperação de falhas. O eixo do desenho é simples: validar no domínio, serializar as mudanças conflitantes na wallet, persistir saldo/ledger/estado/outbox no mesmo commit, deduplicar entradas e tratar a publicação assíncrona como entrega pelo menos uma vez. Constraints e triggers reforçam o que a aplicação calcula; logs, métricas e reconciliação tornam falhas observáveis; testes de integração verificam comportamentos que não podem ser provados apenas por testes unitários.

O resultado é uma base técnica coerente para o escopo do desafio, com limitações documentadas e uma lista explícita de melhorias necessária antes de tratá-la como sistema financeiro pronto para produção.

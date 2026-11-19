# Аннотированный отчет ревью Goldfish (`goldfish_review_report.md`)

**Status:** resolved
**Target:** `concepts_brief.md` (`Lines 1..114`, весь файл)

## Приоритизированные замечания и предложения ИИ

### [Issue 1] [`egm-design` / `egm-codebase-details`] - Severity: Blocker
*   **Affected Scope:** [Lines 38-40](concepts_brief.md#L38-L40), [Lines 48-53](concepts_brief.md#L48-L53) (`## Analysis` & `## Goals vs. Non-Goals`)
*   **Discrepancy Description:** Описание физики столкновения с барьером в `concepts_brief.md` (`bouncedNorm = -vNorm * 0.12`, плавный доворот `dt * 14`, `9 unit tests`) противоречит актуальной кодовой базе (`src/game/track.ts`, `src/game/physics.ts`, `src/game/rules.test.ts`), где устранено залипание в стенах за счет непрерывной интерполяции по нормальным плоскостям сегментов и мгновенного тангенциального выравнивания курса, а число модульных тестов увеличено до 10.
*   **Rationale:** Любое расхождение между спецификацией и реальным кодом вводит в заблуждение при последующей поддержке и приводит к возврату бага с застреванием носа машины в стене.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Замечание полностью валидно. В `concepts_brief.md` необходимо зафиксировать двухкомпонентное решение (`projectWorldToTrack` в `src/game/track.ts` + секция 10 в `src/game/physics.ts`) и обновить количество тестов в `src/game/rules.test.ts` до 10.
*   ***Proposed Edit:***
    *   Location: `## Overview`, `## Analysis` (Lines 38–40), `## Goals vs. Non-Goals` (Lines 48, 53)
    *   Change: Заменить описание 12%-го отскока и плавного доворота на непрерывную интерполяцию нормальных плоскостей сегментов в `src/game/track.ts` и выталкивание по внутренней нормали (`maxAllowedLateral - 0.01`) с мгновенным тангенциальным выравниванием курса (`proj.trackHeading + sign * 0.025`) в `src/game/physics.ts`; обновить число тестов в `src/game/rules.test.ts` с 9 до 10.

---

### [Issue 2] [`egm-implementation-readiness` / `egm-structural`] - Severity: Blocker
*   **Affected Scope:** [Lines 60-65](concepts_brief.md#L60-L65) (`## Key Decisions & Staging for Next Steps`)
*   **Discrepancy Description:** Раздел плана реализации озаглавлен нестандартно (`## Key Decisions & Staging for Next Steps`) и содержит только 3 высокоуровневых пункта без маркировки изменяемых файлов (`[Modify]`), без фаз и без конкретных параметров (`evaluateEngineTorqueAndLimiter`, `projectWorldToTrack`, `stepSingleRacerPhysics`, `WorldCanvas.tsx`, `rules.test.ts`).
*   **Rationale:** Нарушает правило нулевых допущений (`Zero-Decision Rule` из `implementation-readiness-standard.md`).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Замена строк 60–65 на структурированный раздел `## Detailed Implementation Plan` с 5 фазами и явными маркерами `[Modify]` устраняет все блокеры этапов 7, 8 и 9.
*   ***Proposed Edit:***
    *   Location: Lines 60–65 (`## Key Decisions & Staging for Next Steps`)
    *   Change: Заменить заголовок на `## Detailed Implementation Plan` и расписать 5 фаз (`[Modify] src/game/track.ts`, `[Modify] src/game/tuning.ts`, `[Modify] src/game/physics.ts`, `[Modify] src/game/WorldCanvas.tsx`, `[Modify] src/game/rules.test.ts`) с точными формулами и командами верификации.

---

### [Issue 3] [`egm-zoom-out` / `egm-design`] - Severity: Major
*   **Affected Scope:** [Lines 8-49](concepts_brief.md#L8-L49) (`## Overview`, `## Analysis`, `## Goals vs. Non-Goals`)
*   **Discrepancy Description:** В высокоуровневой части отсутствуют описание подсистемы реалистичного ограничителя максимальной скорости (`evaluateEngineTorqueAndLimiter` в `src/game/physics.ts` и `src/game/tuning.ts`) и бюджет памяти процедурных PBR-текстур в `src/game/WorldCanvas.tsx`, а низкоуровневые формулы помещены прямо в обзорный раздел `## Analysis`.
*   **Rationale:** Нарушает стандарты `zoom-out-standard.md` (контроль высоты обзора и полнота корневой архитектуры) и `feature-spec-standard.md`.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Перенос конкретных констант в `## Detailed Implementation Plan`, добавление описания `evaluateEngineTorqueAndLimiter` и фиксация размеров процедурных текстур (`256×256` / `512×512` с `dispose()`) делают документ полным и согласованным с кодом.
*   ***Proposed Edit:***
    *   Location: `## Overview`, `## Analysis`, `## Goals vs. Non-Goals`
    *   Change: Добавить пункт про реалистичный ограничитель максимальной скорости и кривую крутящего момента, указать ограничения разрешения PBR-текстур, а низкоуровневые формулы перенести в `## Detailed Implementation Plan`.

---

### [Issue 4] [`egm-comprehension` / `egm-style`] - Severity: Major
*   **Affected Scope:** [Lines 1-59](concepts_brief.md#L1-L59) (Весь раздел `FeatureRange`)
*   **Discrepancy Description:** Не расшифрована аббревиатура `EAGL`, не определены система координат нормали/касательной трассы (`tx, tz, nx, nz`) и источник каталога шасси (`CHASSIS_CATALOG` в `src/game/tuning.ts`), а также используются субъективные эпитеты (`"On Rails"`, `"Deep Heroic Powerslides"`, `"rock-solid"`).
*   **Rationale:** Снижает понятность документа для нового разработчика и нарушает объективный инженерный стиль (`egm-style`).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Расшифровка терминов при первом упоминании, перевод документа на чистый технический русский язык и замена метафор на измеримые критерии полностью закрывают замечания `egm-comprehension` и `egm-style`.
*   ***Proposed Edit:***
    *   Location: Lines 1–59
    *   Change: Расшифровать `EAGL (EA Graphics Library / физическая модель EA Black Box)`, пояснить систему координат трассы и ссылку на `CHASSIS_CATALOG` в `src/game/tuning.ts`, убрать субъективные метафоры и оформить обновленный `concepts_brief.md` на русском языке.

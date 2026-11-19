# Этап 9: Проверка готовности к реализации (`implementation_readiness_report.md`)

* **Проверяемый документ:** `concepts_brief.md` (`DetailedRange: 60..65`)
* **Применяемый стандарт:** `implementation-readiness-standard.md` (Правило нулевых допущений / Zero-Decision Rule)
* **Файлы контекста (`GoldfishContext`):** `src/game/physics.ts`, `src/game/track.ts`, `src/game/tuning.ts`, `src/game/WorldCanvas.tsx`, `src/game/rules.test.ts`
* **Активные ревьюеры:** `egm-implementation-readiness` (Техлид), `egm-codebase-details` (Аудитор соответствия коду), `egm-style` (Технический редактор)

---

## 1. Технический лид по готовности к реализации (`egm-implementation-readiness`)

### 🔴 Замечание IR-1: Нарушение правила нулевых допущений (Zero-Decision Rule) в строках 60–65
* **Серьезность:** Blocker (Блокер)
* **Затронутая область:** `## Key Decisions & Staging for Next Steps` (строки 60–65)
* **Описание проблемы и руководство к исправлению:** По стандарту `implementation-readiness-standard.md`, раздел плана реализации не должен оставлять разработчику самостоятельных архитектурных или параметрических решений. Сейчас строки 62–64 состоят из трех общих предложений («Refine `stepSingleRacerPhysics`...», «Upgrade the procedural track & city PBR texture generators...», «Run all unit tests...»). Необходимо заменить `## Key Decisions & Staging for Next Steps` на полноценный раздел `## Detailed Implementation Plan` с разбивкой по фазам и конкретными сигнатурами, формулами и порогами:
  1. **Фаза 1 (`[Modify] src/game/track.ts`)**: Непрерывная проекция `projectWorldToTrack(trackId, x, z)` через интерполяцию между нормальными плоскостями сегментов `u0 = (x - s0.x) * s0.tx + (z - s0.z) * s0.tz` и `u1 = (x - s1.x) * s1.tx + (z - s1.z) * s1.tz`, параметр `t = clamp(u0 / (u0 - u1), 0, 1)`, непрерывный `s = (((segIdx + t) / count) % 1 + 1) % 1`.
  2. **Фаза 2 (`[Modify] src/game/tuning.ts`, `[Modify] src/game/physics.ts`)**: Реалистичные потолки максимальной скорости (`198–212 км/ч` в стоке, до `295 км/ч` на Stage 3) и функция `evaluateEngineTorqueAndLimiter` (расчет квадратичного аэродинамического сопротивления, кривой момента по оборотам и мягкой отсечки ЭБУ на 6-й передаче вблизи `stats.topSpeedKmh`).
  3. **Фаза 3 (`[Modify] src/game/physics.ts`)**: В `stepSingleRacerPhysics` — асимметричный фильтр руля (`steerResponse = 22.0 + suspensionStage * 2.2` при возврате/контррулении против `9.2 + suspensionStage * 1.35` на входе), `speedFactor = Math.min(1, Math.abs(forwardSpeed) / 14.5)`, двухрежимный `tireTrajectoryAuthority` (`0.84..0.92` в режиме Grip против `0.14` на ручнике), и тангенциальное скольжение вдоль барьера в Секции 10 (`targetLateral = sign * (maxAllowedLateral - 0.01)`, выравнивание `racer.heading = proj.trackHeading + sign * 0.025` при `signedWallAngle > -0.02` или `Math.abs(angleFromTrack) > 0.65`, повторный вызов `projectWorldToTrack`).
  4. **Фаза 4 (`[Modify] src/game/WorldCanvas.tsx`)**: Генераторы PBR-текстур (`createRoadAsphaltTexture`, `createCurbRumbleTexture`, `createConcreteBarrierTexture`, `createBuildingFacadePBRTextures`).
  5. **Фаза 5 (`[Modify] src/game/rules.test.ts`)**: Проверка всех 10 модульных тестов (включая Тест 8 по EAGL Grip/Drift, Тест 9 по ограничителю скорости на 6-й передаче и Тест 10 по скольжению вдоль правого и левого барьеров и отходу от стены).

---

## 2. Аудитор соответствия кодовой базе (`egm-codebase-details`)

### 🔴 Замечание CD-1: Прямое противоречие с актуальным кодом `src/game/physics.ts` и `src/game/track.ts`
* **Серьезность:** Blocker (Блокер)
* **Затронутая область:** Строки 38–40, 53, 62–64
* **Описание расхождения и обоснование:**
  1. В документе не упомянуты файлы `src/game/track.ts` и `src/game/tuning.ts`, которые фактически изменены для устранения залипания в стенах и настройки лимита скорости.
  2. В строке 62 указаны секции `(Sections 5, 6, and 10)` функции `stepSingleRacerPhysics`, но не упомянута функция `evaluateEngineTorqueAndLimiter` (секция 4).
  3. В строке 53 указано `9 unit tests in src/game/rules.test.ts`, тогда как в `src/game/rules.test.ts` фактически 10 тестов (`pass 10`).

### 🟡 Замечание CD-2: Отсутствие маркеров операций над файлами (`[Modify]`)
* **Серьезность:** Major (Существенное)
* **Затронутая область:** `## Key Decisions & Staging for Next Steps` (строки 62–64)
* **Описание расхождения и обоснование:** Согласно `agents/codebase_details.md`, список затрагиваемых файлов в плане реализации должен явно помечать каждый путь маркером `[Modify]`, `[Create]` или `[Delete]`.

---

## 3. Технический редактор (`egm-style`)

### 🟢 Замечание STY-3: Некалиброванное утверждение в пункте 3 плана работ
* **Серьезность:** Nit (Мелкое)
* **Затронутая область:** Строка 64
* **Обоснование стиля (`CALIBRATE`):** В строке 64 следует указать точную команду запуска тестов (`npx --yes tsx --test src/game/rules.test.ts`) и точные пороговые значения проверок в Тестах 8, 9 и 10.

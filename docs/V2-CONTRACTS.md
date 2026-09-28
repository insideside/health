# v2 — контракты данных и модулей

Единый источник правды для всех, кто пишет код v2. Меняете формат — меняйте здесь.
Что умеет приложение — [README](../README.md) и [HOW-IT-WORKS.md](HOW-IT-WORKS.md). Базовая механика записей и синка — [ARCHITECTURE.md](ARCHITECTURE.md).

## Общие правила

- Все данные пользователя — записи `{id, user_id, kind, date, data, updated_at, deleted}` (см. `app/db.py`).
  Новый вид записи = новое значение `kind`; его нужно добавить в `KINDS` в `app/server.py`.
- Даты — `YYYY-MM-DD` (локальные), время суток — `HH:MM`, моменты — миллисекунды epoch.
- Детерминированные id там, где запись «одна на день»: `kind:{uid}:{date}` — чтобы два устройства без сети
  не создали дублей.
- Партнёр видит только `PUBLIC_KINDS = ("dsum", "ach", "wsum")` (`app/db.py`).
- Адаптивная логика — на клиенте и должна работать офлайн. Сервер: ИИ, чат, нормы, еда, импорт, бэкап.
- Тексты — по-русски, стиль «Стенограммы» (`docs` transkribator/STYLE.md): только токены, одна `.btn.solid` на экран.
- Правило тона ИИ: `app/userdata.py` → `TONES`, `RULES`. Все системные промпты собираются через них.

## Виды записей

### `profile` — `profile:{uid}` (расширен)
```js
{
  name, sex: 'm'|'f', birth: 'YYYY-MM-DD', height, weight, activity: 'sedentary'|'light'|'moderate'|'high',
  tone: 'soft'|'coach'|'sergeant', glass_ml: 250, setup_done: bool,
  body_type: 'ecto'|'meso'|'endo'|'mixed'|null,
  patterns: string,                       // «что мне помогает, особенности»: свободный текст для ИИ
  limitations: string[],                  // коды из LIMITATIONS ниже
  limitations_note: string,
  diet: string,                           // код из DIETS
  allergies: string,                      // аллергии и исключения
  medications: string,
  extra_notes: string,                    // «дополнительно учесть» — уходит во все промпты
  gym: bool, weekdays: number[],          // дни силовых (0 = пн)
  equipment: string[],                    // домашний инвентарь (коды каталога)
  time_budget_min: number,                // максимум минут в день на тренировки (по умолчанию 60)
  max_sessions_week: number,              // максимум силовых в неделю (по умолчанию = weekdays.length)
  schedule: {                             // рабочий график
    irregular: bool,                      // смены / плавающий
    days: { [0..6]: { busy: 'HH:MM-HH:MM' | '', slot: 'morning'|'day'|'evening'|'any'|'none' } }
  },
  start_mode: 'smooth'|'hard', start_date: 'YYYY-MM-DD',
  activities: [{ type, per_week, weekdays?: number[], minutes, intensity: 'low'|'mid'|'high' }],   // type — id из activities.json
  modules: {                              // короткие ежедневные модули
    morning: { enabled, minutes: 5|10|15|20 },
    neck:    { enabled, per_week, minutes: 5|10 },       // шея и скулы
    posture: { enabled, per_week, minutes: 5|10|15 },
  },
  eating_window: { enabled, from: 'HH:MM', to: 'HH:MM' },
  reminders: [{ kind: 'sleep'|'state'|'food'|'water'|'weight'|'measure'|'workout', time: 'HH:MM', enabled }],
  cycle: { enabled, last_start: 'YYYY-MM-DD', length: 28, period: 5 },   // только в профиле женщины, по желанию
  pace: 'slower'|'normal'|'faster',       // ручная поправка темпа
}
```
`LIMITATIONS`: `knees, lower_back, neck, shoulders, wrists, hips, ankles, hypertension, heart, hernia, varicose, pregnancy, asthma, diabetes, overweight_joints`.
`DIETS`: `normal, vegetarian, vegan, pescatarian, lactose_free, gluten_free, low_carb, keto, halal, kosher, if_16_8, if_18_6, diabetic`.

### `goal` — `goal:{uid}` (заменяет v1)
```js
{
  goals: [{ type, amount?, zones?: string[], priority: 1|2|3 }],
  // type: lose_fat | gain_muscle | endurance | tone | sleep | gain_weight | maintain | posture | neck
  // amount: кг для lose_fat/gain_muscle/gain_weight; zones — ZONES
  habits: string[],        // less_sugar, less_flour, less_coffee, less_alcohol, less_fastfood, less_late_eating, more_veg, more_protein, more_fiber
  deadline: 'YYYY-MM-DD'|null,
  text: string,
  // совместимость с v1 (norms.py читает и то, и другое): fat_kg, muscle_upper_kg, muscle_lower_kg
}
```
`ZONES`: `chest, shoulders, arms, back, abs, sides, glutes, legs, neck`.

### `target` — uuid (расширен, пишет сервер `/api/norms`)
v1-поля + `fiber`, `sleep_hours` (7.5), `steps_manual` (ручная правка шагов — если есть, важнее `steps`),
`timeline: { realistic_weeks, options: [{ label: 'comfortable'|'moderate'|'aggressive'|'unrealistic', deadline, weeks, deficit_pct, sessions }] }`,
`intensity: { deficit_pct, weekly_sessions, weekly_minutes, cardio_minutes }`, `habits_targets: {…}`.

### `sleep` — `sleep:{uid}:{date}` (date — день пробуждения)
```js
{ bed: 'HH:MM', wake: 'HH:MM', fall: 'fast'|'moderate'|'long', continuity: 'solid'|'interrupted',
  awakening: 'self'|'alarm', rise: 'fresh'|'hard', note, entered_at }
```
Длительность и оценку считает `coach.sleepInfo(rec)` → `{ hours, verdict: 'short'|'ok'|'long', score: 0..100 }`.

### `state` — `state:{uid}:{date}`
`{ wellbeing: 'great'|'good'|'meh'|'broken', soreness: 'none'|'light'|'strong', stress: 'low'|'mid'|'high', note, entered_at }`

### `daytype` — `daytype:{uid}:{date}`
`{ type: 'cheat'|'special'|'sick'|'rest', note }` — в такие дни тренер не ругает (sick/rest — и не требует тренировок).

### `activity` — uuid, date
`{ type, minutes, intensity: 'low'|'mid'|'high', kcal, note, source: 'manual'|'health', entered_at }`
kcal = MET(type, intensity) × вес × часы (`plan.activityKcal`).

### `body` — `body:{uid}:{date}` (расширен)
`{ weight, neck, chest, waist, belly, hips, arm_l, arm_r, thigh_l, thigh_r, calf_l, calf_r }` — сантиметры, всё необязательно.

### `injury` — uuid
`{ zone, note, since: 'YYYY-MM-DD', resolved: 'YYYY-MM-DD'|null }` — зоны из `ZONES` + `knees, lower_back, wrists, ankles, hips`.
Пока не закрыта, упражнения с этой зоной в `contraindications` исключаются из генераторов.

### `routine` — `routine:{uid}:{date}:{module}` (module: morning|neck|posture|home)
Сгенерированная клиентом короткая тренировка:
`{ module, minutes, title, exercises: [{ id, amount: '30 с'|'12 раз', per_side, done }], done, seed }`.

### `workout` — `wo:{uid}:{date}` (расширен)
v1-поля + `variant: 'full'|'light'|'recovery'|'moved'`, `planned_minutes`, `moved_from`, `moved_to`,
`source: 'program'|'generated'`. Логи подходов — как в v1 (`exercises[].log[] = {reps, weight, done}`).

### `food` (расширен)
v1 + `time: 'HH:MM'`, `entered_at`, `out_of_window: bool` (считает клиент).
### `favfood` — uuid
`{ title, text, items, totals, meal }` — избранные блюда для быстрого ввода.

### `chat` — uuid, date
```js
{ role: 'user'|'coach', text, created,
  source: 'ai'|'rule'|'quick',
  rule?: string,                          // для сообщений-правил: код правила (без дублей за день)
  actions?: [{ id, label, kind, params, status: 'offered'|'done'|'declined' }] }
```
Сообщения-правила тренер пишет с id `chat:{uid}:{date}:{rule}` — одно правило раз в день.

### `wsum` — `ws:{uid}:{monday}` (публичный)
Сводка недели: `{ score, grade: 'A'..'E', emoji, parts: { activity, sleep, food, water, state }, xp }` — считает клиент.

### Уже были
`item`, `log`, `dsum`, `ach`, `coach`, `program` — как в v1. У `item` появилось `source: 'habit'` (пункты из пищевых привычек).

## Справочники (`app/seed/`)

### `exercises.json` (расширен)
v1-поля + 
```js
{
  tags: string[],              // morning, warmup, mobility, posture, neck, face, cardio, core, recovery, low_impact, quiet (можно в квартире)
  zones: string[],             // из ZONES — на что работает
  contraindications: string[], // коды LIMITATIONS и зон травм: knees, lower_back, …
  impact: 'low'|'mid'|'high',
  details: {
    summary: string,           // 1–2 предложения: зачем упражнение
    setup: string,             // подготовка и исходное положение подробно
    breathing: string, tempo: string, feel: string,   // что должно ощущаться и где
    cues: string[],            // короткие подсказки
    safety: string[],          // когда не делать / осторожно
  }
}
```
Разделы: зал, дом, зарядка/разминка/мобилити, **осанка**, **шея и скулы**, восстановление.

### `activities.json` (новый)
```js
[{ id: 'cycling', name: 'Велосипед', met: { low: 4, mid: 6.8, high: 10 }, zones: ['legs','glutes'],
   load: 'cardio'|'strength'|'mixed'|'skill', impact: 'low'|'mid'|'high', aliases: ['вел', 'велик'] }]
```

## Клиентские модули (`app/static/`)

| Файл | Что | Экспорт |
|---|---|---|
| `store.js` | данные, синк (v1) | как есть |
| `ui.js` | разметка, формы, модалка, задачи ИИ | `S, esc, num, fmt, field, input, select, chips, textarea, ensureForm, openModal, closeModal, techHtml, showTech, toast, ring, jobFor, addJob, jobNote, dateNav, isBackdated, profile, goal, …` |
| `coach.js` | метрики, серии, уровни, достижения, реплики тренера | v1 + `sleepInfo, sleepStats, stateOf, dayType, weekScore, rampFactor, weekSummary, ruleMessages` |
| `plan.js` | адаптивный план | `readiness(date)`, `workoutVariant(date)`, `weeklyBalance(date)`, `makeRoutine(module, minutes, date)`, `makeHomeWorkout({minutes, focus, date})`, `activityKcal`, `excludedFor(uid)` |
| `app.js` | оболочка: навигация, маршрутизация, события, фон | регистрирует экраны из `views/*` |
| `views/*.js` | экраны | каждый экспортирует `routes: {name: (arg) => html}`, `actions: {act: (el, e) => …}`, по желанию `changes: {act: (el) => …}` и `nav` |

Экраны: `today.js` (день: чек-лист, сон, самочувствие, модули), `calendar.js`, `food.js`, `workout.js` (тренировка, программа, генератор «на любой случай»),
`progress.js` (уровни, замеры, вес, недельный отчёт, достижения), `profile.js` (профиль v2, цели и сроки, активности, модули, напоминания),
`chat.js` (чат с тренером).

## Серверные модули (`app/`)

| Файл | Что |
|---|---|
| `norms.py` | нормы v2: несколько целей, сроки и шкала реалистичности, темп, режим старта, активности, привычки, сон |
| `ai/jobs.py` | задачи ИИ: food, norms, program (v2: активности, ограничения, травмы, тип телосложения, паттерны, режим старта, темп, бюджет времени), weekly, mealplan, recipe, analysis |
| `chat.py` | `POST /api/chat` — ответ ИИ с действиями; `POST /api/chat/action` — выполнить действие |
| `health.py` | `POST /api/health/import` (токен), `GET/POST /api/health/token` |
| `backup.py` | ежедневная копия БД в `data/backups/`, `GET /api/export` |
| `nutrition.py` | план рациона из справочника под БЖУ и диету (код), оценка дня питания |

## Дополнения: массаж и календарь-дневник

- `activity.details` — подробности активности по полям из `activities.json → fields`. Для массажа (`type: 'massage'`):
  `{ kind: 'wellness'|'therapeutic'|'sport'|'relax'|'lymph'|'anticellulite'|'self'|'device', zones: string[], by: 'specialist'|'partner'|'self'|'device',
     pain: 0..3, after: 'better'|'same'|'worse', note }`.
  `activities.json` у вида может быть `fields: [{ key, label, type: 'choice'|'multi'|'scale'|'text', options?: [[value, label]] }]` — форма строится по ним.
- **Оценка дня** — `coach.dayGrade(date, uid)` → `{ score: 0..100, grade: 'good'|'ok'|'bad'|'none', parts: { checklist, sleep, state, food, activity } }`:
  сводная, не только % чек-листа. Для партнёра — из `dsum.grade`/`dsum.score` (клиент публикует их в `dsum`).
- Календарь: маршрут `#calendar/{scale}/{anchor}` — scale: `day|week|month|quarter|year`, anchor — дата.

## Точные интерфейсы клиентских модулей

`coach.js` (v1 + новое; все функции синхронные, кроме refresh*/award*; uid по умолчанию — текущий пользователь;
результаты кэшируются на один синхронный «такт» и сбрасываются в ближайшей микрозадаче — после любого await данные свежие):
```js
sleepInfo(rec, uid)            // rec — запись или её data → { hours, verdict: 'short'|'ok'|'long', score: 0..100, label: 'недосып'|'норма'|'пересып', target } | null
                               // short < max(7, target − 0,75), long > max(9,5, target + 1,5); target = target.sleep_hours || 7,75
sleep(date, uid)               // → data записи sleep или null
sleepTarget(uid)               // → часы сна по норме
sleepStats(days = 14, uid, end = today)
                               // → { count, avgHours, avgScore, avgBed, avgWake, bedtimeSpreadMin, wakeSpreadMin, shortNights, longNights,
                               //     byFactor: {fall:{fast:n,…}, continuity, awakening, rise}, trend: 'up'|'down'|'flat'|null,
                               //     withState: {good, bad} (средний балл сна в хорошие/плохие по самочувствию дни), nights: [{date, hours, score, verdict, label}] }
stateOf(date, uid)             // → data записи state или null
dayType(date, uid)             // → 'cheat'|'special'|'sick'|'rest'|null
dayGrade(date, uid)            // → { score|null, grade: 'good'|'ok'|'bad'|'none', parts: {checklist, sleep, state, food, activity}, type, pct }
                               //   веса 0,3/0,2/0,1/0,2/0,2 по имеющимся частям; cheat/special/sick — без food; special/sick/rest — без activity
                               //   (и без пункта «тренировка» в чек-листе); sick/special не бывают 'bad'. Для партнёра — из dsum.grade/score.
gradeOf(score)                 // → 'good' ≥ 70 | 'ok' ≥ 45 | 'bad' | 'none'
refreshDsum(date)              // async: dsum теперь { pct, done, total, xp, workout, grade, score }; заодно refreshWsum(неделя даты)
weekSummary(monday, uid)       // → { monday, score|null, grade: 'A'..'E'|null, emoji: 🔥 💪 🙂 😐 😴, parts: {activity, sleep, food, water, state, workouts:{planned, done}},
                               //     days: [{date, grade, score, type}], xp, logged } — score/grade null, если за неделю нет данных
refreshWsum(monday)            // async: пишет wsum:{uid}:{monday} = { score, grade, emoji, parts, xp }, если изменилось
rampFactor(date, uid)          // 0.6..1 — плавный старт за 21 день от profile.start_date (1 для 'hard')
streakMin(date, uid)           // порог серии с учётом плавного старта (50→80); streaks() им пользуется; дни sick/special серию не рвут
isBackdatedRec(rec)            // data.entered_at позже конца дня записи + 12 ч
ruleMessages(now = new Date()) // → [{ rule, text, mood }]; rule ∈ sleep (11:00), food (14:00 или начало окна + 3 ч), food_evening (20:00, < 2 приёмов),
                               //   state (12:00), activity_unclear, measure (> 30 дн. с последнего замера или ещё нет замеров), water, weight, workout.
                               //   Время sleep/food/state/measure берётся из profile.reminders того же kind (enabled:false выключает правило);
                               //   water/weight/workout — только если такое напоминание задано. Срабатывает, только если данных за сегодня ещё нет.
lines()                        // → [{event, mood, text}] по приоритету; v2-события: sick_day, special_day, cheat_day, state_broken, sleep_short,
                               //   sleep_poor, sleep_great, too_many_cheat (> 1 за 7 дн.), too_many_special (> 3 за 30 дн.), workout_light,
                               //   habit_sugar|flour|coffee|alcohol|fastfood|late, out_of_window, balance_deficit (с четверга, ≥ 15 мин), deload,
                               //   backdated, plateau, plateau_lifts. В cheat/special/sick-дни упрёков нет. В текстах {м|ж} — по profile.sex.
cheatAdvice(date)              // → { allowed: bool, reason }
smoothedWeights(uid)           // → [{date, w, trend}] — EMA с периодом 7 дней (учитывает пропуски)
plateau(uid)                   // → { weight, measures, lifts, any } — ≥ 3 недель без сдвига к цели (goalDir)
cycleInfo(date, uid)           // → { day, phase: 'menstrual'|'follicular'|'ovulation'|'luteal', length } | null
// помощники (тоже экспорт):
daysBetween(a, b), weekday(date) /* 0 = пн */, mondayOf(date), toMin('HH:MM'), goalDir(uid) /* 'down'|'up'|'hold'|null */,
measures(uid) /* записи body с обхватами */, foodDay(date, uid) /* {kcal,p,f,c,fiber,n,meals,calculated,hits:{sugar,flour,coffee,alcohol,fastfood},outside[],late[]} | null */,
foodFlags(name, group) /* Set привычек по названию еды */, inWindow(time, eating_window), habitViolations(date, uid) /* [{habit, what, count, time?}] */,
isPassive(type) /* массаж/сауна/дыхание — не движение */, exerciseSec(ex), estimateMinutes(workoutData),
activityMinutes(date, uid) /* {planned, program, activity, activityRaw, recovery, total} */, weekActivity(date, uid) /* основа weeklyBalance */
```
Перенесённая тренировка остаётся на исходной дате с `variant: 'moved', moved_to` — `progress()`/`dayScore()` её не считают.

`plan.js` (каталог — `store.getMeta('exercises')`, активности — `store.getMeta('activities')`; если в каталоге нет v2-полей,
tags/zones/contraindications/impact выводятся из v1-полей):
```js
readiness(date, uid)                      // → { score: 0..100, level: 'high' ≥ 80 |'normal' ≥ 55 |'low' ≥ 35 |'rest', reasons: string[] }
workoutVariant(date)                      // → { variant: 'full'|'light'|'recovery'|'move', why, adjust: {setsFactor, restFactor}, readiness, to? }
applyVariant(date, variant)               // async → { ok, variant, to?, reason? }; variant: full (вернуть исходную) | light (подходы ×0,6, отдых ×1,25)
                                          //   | recovery (подбор мобилити 15–25 мин) | move (на ближайший свободный день этой недели);
                                          //   исходный состав хранится в workout.data.original; начатую тренировку (есть логи) не трогает
weeklyBalance(date)                       // → { monday, daysLeft, plannedSessions, doneSessions, plannedMin, doneMin, activityMin, deficitMin, behindMin, suggestion }
excludedFor(uid)                          // → Set кодов противопоказаний (ограничения + открытые травмы)
pickExercises({ tags, zones, minutes, place, date, seed, level, avoid, equipment, noJump, quiet })
                                          // → [{ id, amount: '30 с'|'12 раз', per_side, name, unit, sec }]
makeRoutine(module, date) | makeRoutine(module, minutes, date)
                                          // async → запись routine (или null, если каталог не загружен); data + rounds, note (для neck)
makeHomeWorkout({ minutes, focus, date, scenario?, equipment?, noJump?, quiet?, zones? })
                                          // async → запись workout (source 'generated', planned_minutes, scenario; replaced — если заменила программную)
buildHomeWorkout(opts)                    // то же без записи → data
SCENARIOS                                 // [{ id, title, minutes, focus, note, equipment?, noJump?, quiet?, zones?, tags? }] — 13 сценариев
activityKcal(type, minutes, intensity, weight) // → ккал по MET (type — id, название или алиас)
progressionHint(exId, date, uid)          // → строка-подсказка или ''
needsDeload(uid)                          // → bool: каждая 5-я неделя активной программы или плато рабочих весов + низкая готовность
catalog(), nextFreeDay(date, minutes, uid), findActivity(type), MODULE_NOTES
```

## Серверные эндпоинты v2

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/api/activities` | → `{ activities }` (`[]`, если `seed/activities.json` нет) |
| POST | `/api/norms` | `{ deadline?, pace? }` → `{ target_id, job_id }`. Явные `pace`/`deadline` сохраняются в `profile.pace` / `goal.deadline`. Пустое тело (v1) — как раньше |
| POST | `/api/norms/preview` | `{ deadline, pace?, goal? }` → `{ label, label_ru, weeks, deficit_pct, rate_pct_week, sessions, cardio_minutes, kcal, realistic_weeks, options, warnings }` — без записи; `goal` — несохранённый черновик цели v2 |
| POST | `/api/ai/jobs` | `{ kind: program|weekly|mealplan|recipe|analysis, input }` → `{ job_id }` |
| POST | `/api/chat` | `{ text, message_id? }` → `{ job_id, message_id }`. С `message_id` сервер свою запись не создаёт (её пишет клиент); без него — создаёт запись `chat` role user |
| POST | `/api/chat/action` | `{ message_id, action_id, decline? }` → `{ ok, result: { text, job_id?, record_id?, to? } }`; повторный вызов для `done` → `{ ok, already: true }`; действие не из этого сообщения — 400 |
| POST | `/api/program/rebuild` | `{ reason }` → `{ job_id }` — пересборка будущего плана; 400, если нет активной программы |
| GET/POST | `/api/health/token` | → `{ token }` (POST — выпустить новый, старый перестаёт работать) |
| POST | `/api/health/import` | заголовок `X-Trainer-Token` (или `?token=`); `{ date, steps?, sleep?: {bed, wake} \| [{start, end}], weight?, active_kcal?, workouts?: [{type, minutes, kcal}] }` → `{ ok, imported }`. Инструкция — [HEALTH-SHORTCUT.md](HEALTH-SHORTCUT.md) |
| GET | `/api/export` | → `{ user, exported_at, records }` (файлом) |
| GET | `/api/mealplan/quick?day=&days=` | → `{ date, target, diet, meals: [{ meal, label, title, items, totals }], totals, diff_pct }`; при `days>1` — `{ days: [...] }` |

### Входы и результаты ИИ-задач v2

| kind | input | результат |
|---|---|---|
| `program` | v1-поля (`place, weekdays, weeks, minutes, level, start, notes`) | запись `program` (+ `activities_considered`, `excluded`, `start_mode`, `rebuilt`, `reason`, `days[].minutes`) и `workout` (+ `variant: 'full'`, `source: 'program'`, `planned_minutes`, `ramp: { week, sets_delta, factor }`, `exercises[].sets_base`). Плавный старт: недели 1–2 — на подход меньше (`sets_delta: -1`), `factor` 0.6/0.8/1. Тренировки с отметками (log/done) не трогаются |
| `weekly` | `{ end?, monday? }` | `coach` kind `weekly`: `{ title, text, next[], day_tip, grade: 'A'..'E', emoji_grade, monday, stats }` — `grade` считает код |
| `mealplan` | `{ days: 1..7, notes?, start? }` (или `{ slots, … }` — см. «Рацион на день») | `coach` kind `mealplan`: `{ title, text, days: [{ date, meals: [{ meal, label, title, items[{name, grams, kcal, p, f, c, source}], totals }], totals, diff_pct }], target, diet }` — граммы доводит код под нормы |
| `recipe` | `{ title? , ingredients?: string\|string[] }` | `coach` kind `recipe`: `{ title, time_min, portions, ingredients[{name, grams, source}], steps[], text (совет), totals, per_portion{kcal,p,f,c} }` |
| `analysis` | `{ scope?: 'body'\|'all', months?: 6 }` | `coach` kind `analysis`: `{ title, text, worked[], didnt[], next[], recommendations[], scope, stats }` |
| `chat` | (ставит `/api/chat`) | запись `chat` role coach: `{ text, source: 'ai', reply_to, actions[{ id, kind, label, params, status }] }` |

### `target` (что пишет `/api/norms`, v2)
v1-поля + `fiber, sleep_hours, goals, pace, deadline, exercise_kcal, notes[]`, `steps_manual` (переносится из прошлой версии),
`timeline: { realistic_weeks, realistic_deadline, chosen: {label, deadline, weeks}, options: [{ label, weeks, deadline, deficit_pct, rate_pct_week, sessions, kcal }] }`,
`intensity: { level, label, deficit_pct (минус — профицит), rate_pct_week, weekly_sessions, weekly_minutes, cardio_minutes, cardio_from_activities }`, `habits_targets`.
Шкала сроков для сброса жира — по темпу в % веса в неделю: ≤0,5 комфортно, ≤1 умеренно, ≤1,5 агрессивно, больше — нереально
(рекомпозиция: 0,4 / 0,65 / 1). Набор — по профициту 6 / 11 / 16 %. Уровень: `deadline` из запроса → `pace` из запроса →
`goal.deadline` → `profile.pace`. Если в профиле есть `activities`, бытовой коэффициент ограничивается «лёгким», а активности
и силовые добавляются к расходу по MET (MET − 1, без двойного счёта покоя).

Действия чата (`actions[].kind`): `skip_today {date}`, `move_workout {from, to}`, `lighten_today {date}`, `swap_exercise {date, from, to}`,
`recalc_norms`, `rebuild_program`, `set_daytype {date, type}`, `add_injury {zone, note}`, `set_pace {pace}`, `log_food {text, meal}`,
`log_activity {type, minutes, intensity}`. Выполняет сервер (запись через `db.server_put`) — клиент получит синком.
Что делает сервер: `skip_today` — `daytype` rest + перенос тренировки на ближайший свободный день (≤ 3 дней), иначе `workout.skipped = true`;
`move_workout` — новая `wo:{uid}:{to}` (`moved_from`), старая удаляется (`moved_to`); занятый день — 409 (при разборе ответа ИИ занятый `to`
заменяется ближайшим свободным); `lighten_today` — подходы ×0,6, отдых ×1,3, `orig_exercises`, `variant: 'light'`;
`swap_exercise` — только упражнение из каталога без противопоказаний; `set_pace` — пересчёт норм + пересборка программы;
`log_food` — запись `food` + расчёт (без ИИ, если всё распознано, иначе задача `food`); `log_activity` — ккал по MET.

## Справочник продуктов

Общий для всех аккаунтов (супруги видят продукты друг друга). Таблица `foods` (миграция добавляет колонки):
`state` (`dry` сухой до варки | `raw` сырой | `cooked` готовый | `as_sold` как продаётся | `fresh` свежий), `generic` (усреднённый
«≈ в среднем»), `note`, `cooked_ratio` (во сколько раз вес растёт при варке), `brand`, `source` (`seed` | `manual` | `web` | `ai`),
`created_by`, `created_at`, `updated` (мс), `verified`, `deleted` (строки не удаляются — клиенты синхронизируются по `updated`).
`seed_foods()` обновляет seed-строки по имени, сохраняя `id` (на них ссылаются записи еды); продукты людей не трогает.
Все значения — на 100 г (напитки — на 100 мл).

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/api/foods/all?since=` | → `{ foods: [{id, name, aliases, group, state, generic, note, kcal, p, f, c, portions, cooked_ratio, source, brand, created_by, verified, updated}], deleted: [id], now, full }`; без `since` — весь справочник, с `since` — изменения после него. Пустые поля опускаются |
| GET | `/api/foods/recent?limit=20` | → `{ foods: [... + count, last_grams, last_used] }` — история человека по его записям `food` (позиции с `food_id`, старые — по имени) за 180 дней |
| POST | `/api/foods` | `{ name, state?, kcal, p, f, c, portions?, brand?, note?, group?, source?: manual\|web\|ai, force? }` → `{ ok: true, food, updated }` или `{ ok: false, need_confirm: true, warnings }` (калории не сходятся с 4·Б+4·У+9·Ж больше чем на 25 %, значения вне правдоподобного диапазона для вида и состояния) — повторить с `force: true`. Имя уникально без учёта регистра: своё — обновляется (непереданные поля остаются), чужое или из справочника — 409. Отрицательные, > 950 ккал или Б+Ж+У > 105 г — 400 |
| PUT | `/api/foods/{id}` | те же поля (частично) → как POST; только свои продукты (иначе 403) |
| DELETE | `/api/foods/{id}` | → `{ ok }`; только свои; строка помечается `deleted` |

**ИИ-задача `foodlookup`** (`POST /api/ai/jobs {kind: 'foodlookup', input: {query, state?}}`): кандидаты из справочника
(совпадение + тот же продукт в других состояниях + похожие), Open Food Facts (`cgi/search.pl`, при 503 — `search.openfoodfacts.org`;
для латинского бренда — отдельный поиск по бренду; без сети — пропускается), модель (`think: true`) выбирает значения
в запрошенном состоянии; код перепроверяет энергию, сумму БЖУ, диапазоны (сухие крупы 290–400, варёные 70–200, овощи ≤ 110,
масло 850–910…) и расхождение со справочником. Результат **не сохраняется**:
`{ query, name, state, group, kcal, p, f, c, confidence: low|mid|high, sources: [{label, kind: db|off, title, brand, url, kcal, p, f, c, state, id, used}],
reasoning_short, warnings[], web, web_error, model, source: web|ai, local[], cooked_ratio }` — клиент показывает для проверки и сохраняет через `POST /api/foods`.

**Записи `food`:** позиции получают `food_id` и `state` (из справочника, в т. ч. выбранные в окне «Из справочника» —
тогда `status: 'calculated'`, `source: 'picker'`, без ИИ). При разборе текста «гречка 80 г» без слова о состоянии
сервер берёт то состояние продукта, которое человек чаще ел (`food.Index(uid).prefer_used`).

**Клиент `foods.js`:** `search(query, {limit})`, `get(id)`, `findByName(name)`, `recent(limit)` (по локальным записям, офлайн),
`usage()`, `refresh(force)`, `macrosFor(food, grams)`, `itemFor(food, grams)`, `portions(food)`, `save(fields, {force, id})`,
`remove(id)`, `pushPending()`. Кэш — `meta.foods = {items, ts}`; продукты, созданные без сети, — `meta.foods_pending`
(id `tmp-…`, после отправки ссылки `food_id` в записях заменяются на настоящие).

## Рацион на день (v3, п. 14)

Раздел «Рацион на день» на экране «Питание» (`views/food.js` → `mpSection`, стили `.mp-*` в `ui-a.css`). Работает без сети.

**Клиент `mealplan.js`:** `buildDayPlan(date, { variant?, workoutTime?, fullDay? })` →
`{ date, source: 'local', target{kcal,p,f,c,fiber}, eaten|null, slots[], totals, day_totals, diff_pct, health, notes[], workout|null, activities[], wake, bed, thin }`;
слот — `{ key, kind: breakfast|snack|lunch|dinner|pre|post, time, label, reason, meal, pre?, post?, status?: 'past'|'logged', target{kcal,p,f,c}, title?, items[], totals }`,
позиция — `foods.itemFor` + `fiber` (≈, по виду продукта), `pieces?`, `hint?` («сухой · ≈200 г готовой»), `home?`, `usual?`, `optional?` + `alt?` (спортпит).
- Слоты: пробуждение (`sleep` дня → средние 14 дн. → 07:00), сон (−3 ч на ужин), рабочие часы и `slot` из `profile.schedule`, `eating_window`,
  медианы времени приёмов из истории (6 нед., ≥ 3 записи), тренировка (`wo:` дня: `estimateMinutes`; время — `workout.time` → напоминание
  `workout` → по `slot` распорядка; можно поправить на экране) или активность ≥ 30 мин (запланированная на день недели или записанная).
  Перекус «за 60–90 мин до» — если нет основного приёма за 1,5–3 ч до начала; «после» — отдельно или ужин/обед после тренировки; промежутки > 4,5 ч — перекус.
- Цели слотов: доли калорий, белок 25–48 г на основной приём, 20–32 после тренировки; жиры меньше до тренировки; в день тренировки 8 % калорий жиров → углеводы.
  Сегодня уже съеденное вычитается, прошедшие слоты — `past`, записанные из плана — `logged` (`food.data.mp_slot`).
- Кандидаты: продукты из истории (`foods.usage`; «любовь» к жареной грудке переходит на запечённую той же основы) ∩ здоровое (`unhealthy()`: группы
  фастфуд/сладости/напитки/соусы/колбасы/готовые блюда, жареное, копчёное, сладкое, чипсы…; привычки `less_flour`/`less_sugar`; диета; аллергии;
  при лекарствах убираются грейпфрут/помело) ∪ базовые продукты ∪ «что есть дома» (сильный приоритет). Спортпит — только если человек его ел или цель — мышцы,
  и только в день тренировки, с пометкой «по желанию». Граммы — итерационно под Б/У/Ж слота, затем день целиком; округление до 5–10 г или штук.
- `healthOf(slots, T)` → `{ score, parts{fiber, protein, sugar, variety}, notes[], fiber_target, veg_fruit_g }`.
- `pantry()/addPantry/removePantry/setPantry` — `meta.pantry = [{id, name}]`; `excluded()/toggleExclude(food)` — `meta.mp_exclude` («не предлагать»). Не синхронизируются.
- `aiInput(plan)` — вход ИИ-задачи; `aiPlanFor(date)` — последний ИИ-рацион на дату в той же форме (`source: 'ai'`).

**ИИ-задача `mealplan` с `slots`:** `input = { date, variant: 'day', slots: [{ key, kind, time, label, reason, meal, target, items[{name, grams}] }], pantry[], usual_foods[], exclude[], workout, activities[], target, eaten }`
→ запись `coach` (date = день) `{ kind: 'mealplan', variant: 'day', date, title, text, slots: [{ key, kind, time, label, reason, meal, title, items, totals, recipe: {steps[], time_min}|null, source: 'ai'|'local' }], totals, day_totals, diff_pct, target, dropped[], notes[], created }`.
Сервер (`nutrition.check_slot_items`, `fit_slot`, `unhealthy` — те же правила, что в клиенте) оставляет только продукты из справочника, здоровые, по диете и не из `exclude`,
пересчитывает БЖУ и доводит граммы под цели слота; пустой слот заполняется проверенным локальным вариантом. Без `slots` задача работает по-старому (`days`).
Кнопки «Идеи на день» и «План с ИИ» (многодневный) из раздела рецептов убраны — старые многодневные планы по-прежнему показываются.

## Соревнование пары («Вместе», `#together/{понедельник}`)

По желанию, включает каждый сам: `profile.compete = { enabled: bool (по умолчанию выкл.), show: string[] }`,
`show` ⊆ `xp, steps, workouts, activity, sleep, grade, streak` (по умолчанию все). Счёт виден, только когда включено у обоих;
сравниваются категории из пересечения `show` обоих. **Питание и вес не публикуются никогда.** Новых видов записей нет —
всё идёт через публичные `dsum`/`wsum` (`PUBLIC_KINDS` не менялся).

- `dsum` (пока `compete.enabled`): `+ compete: true, share: string[]`, по согласию `steps` (из пункта «Шаги»),
  `activity_min` (`activityMinutes().total`), `sleep_h`; после выключения — `compete: false` без этих полей.
  `cheer: { text ≤ 80, at }` — последняя фраза «Подбодрить» (в своей `dsum` за сегодня; сохраняется при пересчёте).
- `wsum` (пока включено): `+ compete, share`, `steps_total`, `activity_min`, `workouts_done`, `sleep_avg`, `sleep_n`,
  `streak` (текущая серия; у прошлых недель — опубликованная тогда). Пока включено, `wsum` пишется и без оценки недели.
- Включение/выключение или смена `show` переопубликуют `dsum`/`wsum` за 8 недель (`coach.refreshCompete`) — поля убираются сразу.
- Статус партнёра — по его самой свежей `dsum`/`wsum` с полем `compete`.
- Совместные задания: 3 в неделю из пула (детерминированно по ISO-неделе); за выполненное каждый пишет себе
  `ach:{uid}:couple_{id}_{monday}` `{ code, title, earned, couple: true, monday }`.
- Прочитанная фраза партнёра: `meta['cheer_seen:{partnerId}'] = at`.

`coach.js`: `COMPETE_CATS, competeSettings(uid), partner(), partnerCompete(pid), duel(monday)` →
`{ state: 'no_partner'|'me_off'|'partner_off'|'ok', cats[{key,label,me,them,win:'me'|'them'|'tie'|null}], score{me,them}, days[7], shared }`,
`duelLine(d)` (реплика тоном), `duelScoreLine(d)`, `challenges(monday)`, `awardCouple()`, `coupleAchievements()`,
`duelHistory(8)`, `jointStreak(pid)`, `CHEERS`, `sendCheer(text)`, `partnerCheer()`, `unseenCheer()`, `markCheerSeen()`, `myCheer()`,
`refreshCompete(weeks = 8)`. Экран — `views/together.js` (там же раздел профиля `competeBody()` и `setCompete()`), стили — `ui-c.css`.

## Цели v3 (цели-показатели)

Цели не только про вес: «талия 96 → 88 см», «руки +2 см», «отжимания 12 → 30», «шаги 11 000». Хранятся в том же
`goal:{uid}.data.goals[]` рядом с качественными целями v2 (`lose_fat`, `tone`, `endurance`…); v1-поля (`fat_kg`, `muscle_*_kg`) по-прежнему читаются.
```js
{ type: 'metric', metric: 'waist', from: 96, to: 88, unit: 'см',
  deadline: 'YYYY-MM-DD'|null,   // свой срок; без него — общий goal.deadline
  priority: 1|2|3, since: 'YYYY-MM-DD' }   // since — с какого дня считаем прогресс
```
Направление — из `from`/`to`. Одна цель на показатель.

**Каталог** (`goals.js → CATALOG`, зеркало — `norms.METRICS`; меняете одно — меняйте и другое):

| Группа | metric | Откуда текущее значение |
|---|---|---|
| Обхваты | `waist, belly, hips, chest, neck, arms` (среднее `arm_l/arm_r`), `arm_l, arm_r`, `thighs`, `calves` | последняя запись `body` с этим полем |
| Вес и состав | `weight` (сглаженный тренд), `body_fat_pct` | `body.weight`; `mtest` (или `body.body_fat`) |
| Сила и выносливость | `pushups_max, pullups_max, plank_sec` | лучшее за 28 дней: `mtest` или подходы упражнений `pushup/pullup/plank` в `workout` (ориентировочно) |
| | `squat_1rm, bench_1rm` | 1ПМ по Эпли из подходов `barbell_back_squat` / `barbell_bench_press` (≤ 12 повторов) или `mtest` |
| | `run_5k_min` | последний `mtest` |
| Привычки | `steps_avg, water_avg, sleep_avg_h, protein_avg_g` | среднее за 7 дней: пункты чек-листа «Шаги»/«Вода», записи `sleep`, `foodDay().p` |

### `mtest` — `mtest:{uid}:{date}:{metric}` (новый вид)
`{ metric, value, entered_at }` — ручной результат теста или показателя без автоматического источника (отжимания на максимум,
% жира, время 5 км). Пишет `goals.record()` (обхваты и вес он пишет в `body`).

**Темпы и реалистичность** — по статистике для пола и уровня (1 новичок: < 24 тренировок или уровень активной программы).
`rates(goal)` → верхние границы «комфортно / умеренно / агрессивно» в неделю, быстрее — «нереально» (та же шкала, что у норм).
Ориентиры: талия −0,35/0,7/1,0 см/нед (женщинам ×0,85, крупнее обхват — быстрее); руки у новичка-мужчины +0,5/0,8/1,2 см/мес
(женщинам ×0,5, средний уровень ×0,5, опытный ×0,25, при одновременном сбросе жира ×0,6); вес −0,5/1/1,5 % в неделю, набор 0,25/0,5/0,75 %;
отжимания +2/3/4 в неделю у новичка (после 30 — вдвое медленнее); подтягивания +0,5/1/1,5, а до первого — 0,15/0,25/0,4;
планка +10/15/25 с; 1ПМ новичка +1,5/2,5/4 % в неделю (жим — 1/2/3 %); 5 км −0,7/1,2/2 % времени; шаги +700/1500/3000; сон +0,15/0,3/0,6 ч.
Физиологические границы (талия < 38 % роста, ИМТ < 18,5, жир < 8 % м / 15 % ж, 5 км быстрее 15/17 мин, руки > +6 см) — всегда «нереально».

**Клиент `goals.js`** (всё офлайн, синхронно, кэш на такт):
```js
CATALOG, GROUPS, metric(id), LEVEL_RU, STATUS_RU
current(metric, uid)      // → { value, date, src: 'body'|'mtest'|'log'|'habit', approx, n? } | null
history(metric, uid)      // → [{ date, v, src }] (привычки — недельные средние)
progress(goal, uid)       // → { from, to, current, pct 0..1, change, trend (ед./нед., МНК), need_week, eta, since_days,
                          //     status: 'done'|'ahead'|'on'|'behind'|'early'|'nodata', label: «по плану»|«отстаёте»|«опережаете»|… }
realism(goal, uid, goals?) // → { label, label_ru, need_week, rates, weeks_typical, realistic_deadline, options[], text, warnings[] }
                          //   работает и для черновика; goals — текущий список (для учёта «сброс + рост одновременно»)
effects(goals?, uid)      // → { mode: 'cut'|'bulk'|'recomp'|'maintain', kcal: 'deficit'|'surplus'|'maintenance',
                          //     zones: {zone: ×}, patterns: {pattern: ×}, tags: {cardio: ×}, cardio_extra, steps_min, protein, notes[], emphasis[] }
exerciseBoost(ex, eff)    // 0..0,45 — вес упражнения в подборе plan.js
lines(uid)                // → [{ event: 'goal_on'|'goal_ahead'|'goal_behind'|'goal_done', mood, metric, priority, text }] — тон и {м|ж} из профиля;
                          //   только при сдвиге ≥ недели с since. Для coach.lines().
record(metric, value, date), recordable(metric), draft(metric), metricGoals(uid), dirOf(goal), level(uid),
fmtNum, fmtSigned, periodText, title(goal)
```
Множители приоритета: главная ×1, важная ×0,7, «по возможности» ×0,4 (к `множитель − 1`); на калории влияют только главные и важные.
`plan.js`: `pickInternal` добавляет `exerciseBoost × 0,5` (модули и разминка держат свои зоны), `buildHomeWorkout` — полный `exerciseBoost`
и +1 подход упражнениям с `exerciseBoost ≥ 0,3`, если укладывается во время.

**Сервер** (`norms.py`): `goals_of` сохраняет цели-показатели; `metric_effects(goals)` → `{fat, gain, cardio, steps, protein, zones, patterns, emphasis}`.
Режим: показатель «вниз» по обхватам/весу/жиру → сброс (как `lose_fat`); руки/грудь/бёдра/таз «вверх» → набор, но при ИМТ ≥ 25 и без
сброса — поддержка калорий (`maintain`); сброс + рост → рекомпозиция. Цель «вес 92 → 84» без `lose_fat` превращается в `lose_fat 8 кг`
для шкалы сроков, «талия −6 см» — грубо в `lose_fat 6 кг` (с пометкой в `notes`). Кардио `+cardio`, шаги — не ниже цели по шагам (≤ 15 000).
`target.intensity.emphasis = { zones, patterns }`. `norms.metric_current(uid, metric)` — текущее значение для промптов.
`ai/jobs.py`: `goals_text(goal, uid)` пишет «талия 96 → 88 см (сейчас 93), к …»; промпт программы получает акценты зон,
проверка ответа — у зон с ×1,2 и выше минимум 2 упражнения в неделю (3 при ×1,4), если каталог позволяет; `program.goal_emphasis`.

## Подключение: зеркала и доступ из интернета (v3, п. 11–12)

**Идея.** Origin PWA не меняется никогда (к нему привязаны IndexedDB и кэш оболочки SW). Меняется только адрес API:
`store.api()` ходит на `getMeta('api_base')` (`''` — свой origin). На другой origin cookie не уходят — там авторизует
**токен устройства** (`Authorization: Bearer …`).

**Сервер** (`app/wan.py`, эндпоинты в `server.py`):
- `data/settings.json`: `server_id` (случайный id сервера), `wan: {mode: off|tunnel|static, url}`, `wan_history[]` (прежние внешние адреса).
- `tunnel` — `cloudflared tunnel --no-autoupdate --no-tls-verify --url https://127.0.0.1:<HTTPS>`; адрес `*.trycloudflare.com`
  из лога; упал — перезапуск с паузой 5 с … 5 мин. **На HTTPS-порт, не на HTTP**: HTTP-порт (127.0.0.1) считается «этим Mac»,
  запросы из интернета не должны приходить на него. `static` — только `https://host[:port]` (роутер → HTTPS-порт Mac);
  хост добавляется в SAN сертификата при следующем запуске (`certs.wanted_names`). Запуск/остановка — `run.py`.
- `GET /api/wan` → `{mode, url, status: off|starting|on|error, error, since, static_url, cloudflared, cert_ok, https_port, local}`;
  `POST /api/wan {mode, url?}`. Только с самого Mac (`wan.is_local`: HTTP-порт + клиент 127.0.0.1 + Host localhost)
  или владельцу (первый зарегистрированный аккаунт), иначе 403.
- `GET /api/config` += `wan_url`, `mirrors: [{url, kind: mdns|lan|wan}]`, `server_id`. `GET /api/version` += `server`.
- Токены устройств: таблица `device_tokens(token_hash sha256, user_id, created, last_seen, label)`.
  Выдаются в ответе `login`/`register` (`device_token`) и `POST /api/auth/device` (только по cookie).
  `current_user` принимает cookie, затем Bearer. `logout` отзывает и сессию, и присланный Bearer.
  `GET /api/auth/devices` → `{devices: [{id (12 hex), label, created, last_seen, current}]}`, `DELETE /api/auth/devices/{id}`.
- `POST /api/auth/device/prove {id: sha256(token)[:16], nonce}` → `{proof: HMAC-SHA256(key=sha256hex(token), nonce)}`:
  зеркало доказывает, что это тот же сервер, до того как клиент отдаст ему токен.
- Middleware `origin_guard`: CORS только для origin'ов самого приложения (`wan.own_origins()`: mDNS/IP/localhost, имена из
  сертификата, текущий и прежние WAN-адреса), без `Allow-Credentials`, заголовки `Authorization, Content-Type`;
  записывающие запросы с чужим `Origin` → 403 (CSRF, в т. ч. на localhost); на HTTP-порту Host ≠ localhost → 403 (DNS-rebinding).
- Вход/регистрация: 10 попыток в минуту с адреса (`wan.client_ip`: для туннеля — `CF-Connecting-IP`), 429;
  только HTTPS или сам Mac; из интернета (`wan.is_wan`) нельзя регистрироваться и `/api/auth/state` не показывает имена.

**Клиент** (`store.js`): `api(path, body, method)` — прежняя сигнатура. Дополнительно:
`apiBase()`, `usingMirror()`, `mirrors()` → `[{url, kind: origin|mdns|lan|wan|manual, manual, current, status: {ok, ms, error, at}|null}]`,
`probeMirrors()`, `setMirror(url|'')`, `addMirror(raw)`, `removeMirror(url)`, `normMirror(raw)`.
meta: `api_base`, `device_token`, `server_id`, `mirrors_server`, `mirrors_manual`; копия списка — `localStorage.trainer_mirrors`
(для страницы «Сервер недоступен» из SW). При сетевой ошибке — проверка всех адресов (`/api/version`, 2 с, тот же `server`,
для чужого origin — `prove`), выбор: свой origin, иначе самый быстрый; на зеркале раз в минуту проверяется свой origin и
при его возврате приложение возвращается. `checkVersion` на зеркале не сбрасывает кэш оболочки.
Экран `#connect` (`views/connect.js`): адреса, ручной ввод, устройства с доступом, управление WAN.

## «Мозг»: память знаний и статистика (v3, п. 3, 4, 6, 8, 9, 10)

Приватность — [PRIVACY.md](PRIVACY.md). Сервер — `app/brain.py`, таблицы `knowledge` и `outcomes` в `db.SCHEMA`.

**`knowledge(kind, key, value JSON, confidence 0..1, source ai|user|stats, uses, created, updated, deleted)`**, уникально по `(kind, key)`:

| kind | key | value |
|---|---|---|
| `food_phrase` | `основа названия|единица` (`brain.phrase_key` = `foodparse.phraseParts().key`; граммы/мл/кг/л → `g`, без единицы — пусто): «тарелка борща» → `борщ|тарелка` | `{items: [{food_id, g}]}` — граммы на 1 единицу (для `g` — доля) |
| `food_alias` | основа формулировки (`stem`) | `{food_id}` |
| `portion` | `{food_id}|{единица}` | `{g}` — граммы на 1 единицу |
| `activity_alias` | формулировка строчными | `{type}` (id из `activities.json`) |
| `exercise_swap` | id упражнения | `{to}` |
| `coach_fact` | — | пишет только сервер (пока не используется) |

Уверенность: первый ответ ИИ — 0,55; согласный повтор/подтверждение +25–35 % от остатка; противоречие ИИ −0,15
(ниже 0,35 — значение заменяется, 0,45); поправка человека смешивает значения 50/50, уверенность 0,55…0,85.
**Клиент применяет знание с уверенности 0,5**, выученную порцию поверх справочника — с 0,7. В ключах — только слова о еде (`impersonal()`).

Учится: `jobs.job_food` (ответ ИИ по нераспознанным кускам → фраза, синоним, порция; позиции получают `phrase`, `pn`),
`foods_api` POST `/api/foods` (сохранён продукт, найденный `foodlookup`, → запрос становится синонимом),
клиент — правка граммов позиции (`phrase` → `food_phrase`, `pu` → `portion`). Применяется: `/api/food/calc` и `job_food`
(`brain.resolve` после справочника), клиент `foodparse.js`.

| Метод | Путь | Тело → ответ |
|---|---|---|
| GET | `/api/brain?since=` | → `{items: [[kind, key, value, conf]], deleted: [[kind, key]], now, full}` |
| POST | `/api/brain/feedback` | `{kind, key, value, signal: confirm|correct}` → `{ok, knowledge}`; 400, если форма неверна или ключ не про еду |
| GET | `/api/brain/insights?refresh=1` | → `{share, min_users: 3, own: {weeks, effects, avg}, groups: [{level, label, users, weeks, effects, avg}], bucket, note?}`; `effects: [{feature, result, r, slope, n, users}]` |
| GET/POST | `/api/brain/settings` | `{web_lookup?}` → `{web_lookup, web_forced_off, ollama_local, knowledge}` |

**`outcomes(subject, week, bucket, features, results, shared, built)`** — пересобирается кодом (≤ раз в 6 ч или `refresh=1`):
`subject` — псевдоним `sha256(meta.stats_salt + uid)[:16]`; `bucket {sex, age: <25|25–34|35–44|45–54|55+, body_type, goal, activity}`;
`features {sleep_h, steps, workouts, protein_gkg, kcal_pct, activity_min, cheat_days, late_meals}`;
`results {d_weight (ср. вес след. недели − этой), d_waist, d_arm (последний замер следующей недели − последний до конца этой, ≤ 14 дн.), grade (wsum.score)}`.
Группы: `same_type → sex_goal → sex_age → goal → all`, только из людей с `profile.share_stats: true`, от 3 человек; сравнение видит только тот, кто делится.

**`profile.share_stats: bool`** (по умолчанию нет) — участие в общей статистике. **`food`**: `calc: 'local'|'db'|'ai'`
(посчитано на устройстве / сервером по справочнику и памяти / уточнено ИИ), `partial: true` — часть позиций посчитана локально,
остальное в `unresolved`; позиции: `source: 'brain'` (из памяти), `phrase`, `pn`, `pu`.

Клиент: `brain.js` — `refresh(force)` (дельта в `meta.brain = {items: {kind: {key: [value, conf]}}, ts}`), `lookup/phrase/alias/portion/
activityAlias/exerciseSwap`, `feedback(kind, key, value, signal)` (без сети — очередь `meta.brain_fb`), `gramsEdited(items, i)`,
раздел профиля `privacySummary()/privacyBody()` + `changes`. `foodparse.js` — порт `food.py`: `split, parseChunk, stem, match, gramsFor,
itemFrom, phraseParts, parse(text) → {items, rest}, totals, localCalc(text)`. `analysis.js` — `insights(uid) → [{title, text, strength:
strong|moderate|weak|none|few, n}]`, `renderInsights()` (блок на «Прогрессе»), `actions['an-compare']` (сервер → `meta.brain_insights`).

## Голос тренера v3: имя, «вчера → сегодня», честные пометки

`names.js` (без зависимостей, проверяется в node): `decl(name, sex)` → `{ nom, gen, dat, acc, ins, prep, voc, sex }` — правила по окончаниям
(-а/-я/-ия/-ья/-ь/согласная/-й), беглые гласные (Павел → Павла, Лев → Льва, Пётр → Петра), исключения (Илья, Любовь, Ия);
`voc` — разговорное обращение только для уменьшительных («Маш», «Вань»), иначе = `nom`. Пол — из `profile.sex`, иначе `guessSex(name)`
(«Саша», «Женя», латиница → null). `fill(template, ctx)`: `{name}`, `{name_gen|dat|acc|ins|prep|voc}`, `{,name}` (→ «, Маша» или пусто),
`{partner}`, `{partner_acc}`…, `{м|ж}` (пол пользователя), `{pa:м|ж}` (пол партнёра, угадывается по имени), `{key}` → `ctx[key]`.
`address(text, form, 'lead'|'tail'|'shout', proper[])` — вставить обращение в готовую фразу. `short(name)` — «Мария» → «Маша» (подсказка).

`coach.js`:
- `lines(now = new Date())` → `[{ event, mood, text, note? }]`. Имя — в одной реплике из списка примерно в 5 днях из 6
  (друг — «Маш», тренер — «Маша», сержант — «Маша!»); в `ruleMessages` — не больше одного сообщения с именем за раз.
- Правила «вчера → сегодня» (утро < 12:00 — до 3 реплик, день — одна вчерашняя + темп воды, вечер ≥ 17:00 — «что ещё успеть», до 3):
  `y_water_low|up, y_steps_low|up, y_workout_done, kcal_over, y_kcal_under, protein_low, y_food_good, y_sweets, y_flour, y_fastfood, y_late,
  y_stress, y_state_up, y_better, week_pace (вт–ср), sleep_tonight, d_water_pace, e_water, e_water_much, e_steps, e_protein, e_kitchen`;
  вес важности учитывает цель (сброс → шаги и калории, набор → белок и тренировки) и привычки из целей. Одна реплика целей из `goals.lines()`.
- `sourceNote(kind)` / `SOURCE_NOTES` — честные пометки для экранов: `stats, coach, norms, norms_default, sleep, goals, trend, food, activity, plan, steps`.
  В репликах — поле `note`; «Сегодня» показывает одну пометку под карточкой тренера.
- `bedtime(date, uid)` → `{ bed, wake, hours, bedMin, basis }` — отбой = обычный подъём − норма сна − 15 мин.
- `attitude(date = вчера, uid)` → `{ good: string[], bad: string[] }` — чем тренер доволен и недоволен (для календаря/итога дня).
- `userName(uid)`, `nameForms(uid)`; `level(xp, sex)` — звания в роде пользователя; `sleepInfo` — дневной сон (лёг ≥ 06:00, < 4 ч) →
  `verdict: 'nap'`, в статистику ночей и оценку дня не идёт; `goalDir` учитывает цели-показатели через `goals.effects().mode`.

Виджет: `GET /api/widget/summary` (только HTTP-порт с 127.0.0.1, `wan.is_local`, без заголовков прокси) → `{ date, pct, active }` —
лучший % чек-листа за сегодня среди аккаунтов и сколько отмечались; имён, еды и веса нет. Индикатор виджета — кольцо дня с «пульсом».


## Пульс и показатели из «Здоровья» (v3)

- `activity` из импорта может содержать `start`, `end` (HH:MM), `distance_km`, `hr_avg`, `hr_max`, `hr_min`,
  `intensity_from: 'hr'` (интенсивность определена по пульсу: < 64 % → low, < 77 % → mid, иначе high от 208 − 0,7·возраст).
- `vitals` — `vitals:{uid}:{date}`: `{ resting_hr, hrv, vo2max, walking_hr, source: 'health' }`. Приватный (не в PUBLIC_KINDS).
- `plan.vitalsSignal(date)` → `{ delta, reason, baseline, resting_hr, hrv, rb, hb }` — поправка к `readiness()`;
  базовая линия — медиана за 21 день, нужно ≥ 5 замеров.
- `POST /api/health/import` принимает `resting_hr` (`resting_heart_rate`), `hrv` (`hrv_ms`), `vo2max`, `walking_hr`;
  в тренировках — `heart_rate` (список замеров) или `hr_avg`/`hr_max`/`hr_min`, `start`/`end`, `distance` (км или метры).
- `period` — `period:{uid}:{date}`: `{ flow: 'light'|'medium'|'heavy', source: 'health' }`, приватный. Импорт `period` / `menstruation`
  (список дат или `{date, flow}`) пересчитывает `profile.cycle` (`last_start`, медианные `length`, `period`, `source: 'health'`);
  `coach.cycleInfo()` берёт последнее начало из отмеченных дней, если они есть.

## Предпочтения упражнений, инвентарь, кардио, погода (v3, п. 17–20)

Код: `app/static/prefs.js` (данные, подписи инвентаря, виды кардио, кэш погоды, сезон), `app/static/plan.js`
(подбор с учётом «не предлагать», замены, сигнал пропусков, `cardioPlan`), `app/static/views/fit.js` (кнопки, карточки,
раздел «Мои упражнения»), `app/weather.py` (сервер), `app/ai/jobs.py → job_program` (каталог и промпт).

Поля профиля (`profile:{uid}`):

| Поле | Формат | Кто пишет |
|---|---|---|
| `exercise_prefs.exclude` | `{ [exerciseId]: { reason: 'uncomfortable'\|'no_equipment'\|'pain'\|'other'\|'skipped', at: ms, via?: 'signal' } }` | кнопка «Не предлагать» (разминка, тренировка, описание техники), чат/«Сегодня» по сигналу |
| `exercise_prefs.like` | `[exerciseId]` — чаще ставятся генератором (+0,35 к счёту) и названы ИИ в программе | «нравится» |
| `exercise_prefs.keep` | `{ [exerciseId]: { at, date } }` — «Оставить»: сигнал считает только пропуски после `date` | «Оставить» |
| `equipment` | коды каталога: mat, chair, bench, dumbbells, kettlebell, stepper, bike, treadmill, elliptical, rower, pullup_bar, dip_bars, band, fitball, jump_rope, foam_roller, ab_wheel, trx | «Что есть дома» (группы — `PF.HOME_EQUIP_GROUPS`) |
| `gym_equipment.missing` | коды, которых нет в зале (machine, cable, barbell, rack, … — `PF.GYM_EQUIP`) | «В зале нет» |
| `cardio` | `{ likes: [activityId], places: ['gym'\|'home'\|'outdoor'] }` | «Кардио» |
| `location` | `{ city, region, lat, lon }` | «Кардио» → «Город для погоды» (поиск через `/api/weather/geocode`) |

Правила:
- «Не предлагать» исключает упражнение из `plan.pool()` (разминки, модули, домашние тренировки, замены) и из каталога программы
  на сервере; закреплённое в `modules.morning.pinned` открепляется. Если упражнение стоит в сегодняшнем невыполненном
  списке — сразу заменяется (`P.excludeExercise(id, reason, ctx)`). Вернуть — «Профиль → Мои упражнения».
- Замена (`P.swapExercise(ctx, to)`, `ctx = {kind: 'routine', module, date, i} | {kind: 'workout'|'warmup'|'cooldown', date, i}`):
  варианты — `P.alternativesFor(id, {place})`: тот же паттерн/категория/зоны, разрешённые местом, инвентарём (дом),
  `gym_equipment.missing` (зал), ограничениями и «не предлагать». Отметки и логи остальных упражнений сохраняются,
  у заменённого — `swapped_from`.
- Неявный сигнал (`P.skipSignals()`): за 35 дней берутся разминки и тренировки, где хоть что-то сделано; если в последних
  ≤ 5 таких появлениях упражнение не отмечено ≥ 3 раз и чаще, чем отмечено, — сигнал. Показ: строка «Тренер заметил» на
  «Сегодня» и правило чата `ex_skip_{id}` (через `C.extend('rules', …)`) с действиями `local_ex_swap` (заменить на X:
  прежнее → «не предлагать» с причиной `skipped`, X → любимые), `local_ex_exclude`, `local_ex_keep`.
- Кардио: норма недели `P.cardioTarget()` = `target.intensity.cardio_minutes`, иначе по цели: сброс 150, поддержание 120,
  набор 60 (цель «выносливость» — не меньше 150). Засчитываются активности с `cardio` (справочник или флаг записи;
  лёгкая интенсивность — наполовину) и выполненные подходы кардио-упражнений в тренировках (`«N мин»` — минуты).
  `P.cardioPlan(date)` → `{target, done, doneToday, left, daysLeft, today: {kind, name, place, minutes, intensity, zone, act,
  eq, generator, finisher, optional, done, reason}, alternatives, note, weather, season, approx}`: кандидаты — виды из
  справочника активностей (`cardio/setting/season/cold_ok/weather_sensitive`; запасной список в `prefs.js`), место — зал
  (если есть тренажёр), дома (если он отмечен), на улице (если позволяют погода или сезон); любимые +3, день зала +1,5,
  холод/ветер/снег снижают шансы улицы, в день тяжёлых ног кардио предлагается «по желанию, спокойно». «Сделал» пишет
  `activity` с `cardio: true, source: 'cardio_plan'`. `weeklyBalance()` возвращает `cardio: {target, done, left}`.
  Реплика тренера — `C.extend('lines', …)`.
- Домашнее кардио на тренажёре: `buildHomeWorkout({focus: 'cardio', machine: 'stepper', intensity})` — один блок «N мин».
- Программа ИИ: каталог без «не предлагать» и без упражнений на отсутствующем в зале оборудовании; в промпте — любимые
  упражнения, кардио-норма, любимое кардио, кардиотренажёры дома; кардио-блок `sets 1, reps «15-20 мин»`.
  В записи `program`: `cardio`, `skipped_exercises`, `gym_missing`.

Погода: `GET /api/weather` (по `profile.location`, или `?lat=&lon=`) → `{lat, lon, tz, current: {time, temp, feels, precip,
code (WMO), wind (м/с)}, daily: [{date, tmax, tmin, precip, code, sunrise, sunset}], fetched_at, cached, stale?, city}`;
`GET /api/weather/geocode?q=` → `{results: [{city, region, lat, lon, tz}]}`. Кэш на сервере — 1 ч на точку (0,01°),
геокодинг — сутки; сеть недоступна — последний ответ с `stale: true`, иначе 502. Выключено — 409 (`meta.weather = '0'`
или `TRAINER_NO_WEB=1`); настройка — `POST /api/brain/settings {weather: bool}` (владелец / этот компьютер), в ответе
`GET /api/brain/settings` — поле `weather`. Клиент: meta `weather` (последний прогноз + `loc`, `saved_at`), запрос не чаще
раза в 30 мин; офлайн — последний прогноз с датой, без прогноза — выбор места «по сезону» (сезон по дате и полушарию).

## Чай и кофе, подсказки из истории еды, разгрузочная неделя, режим ИИ

### `drink` — uuid (новый вид)
`{kind: 'coffee'|'tea', time: 'ЧЧ:ММ', created}` — одна запись на чашку, `date` — день. Время правится в окне чашек
на «Сегодня»; удаление — `deleted`. Отдельные записи, а не счётчик: два устройства не спорят за одно число, время у каждой своё.
Пункты чек-листа `item` с постоянными id `coffee_{uid}` / `tea_{uid}`: `{type: 'counter', target_from: 'coffee'|'tea', track: true}`.
`track: true` — учёт, в процент дня и оценку не входит. Добавляются один раз (`profile.cups_added`).
Клиент: `C.cups(date)` → `{coffee, tea, late (после 14:00), last, lastCoffee, tracked}`, `C.cupList(date, kind)`.
Использование: анализ «кофе и чай после 14:00 и сон», «3+ чашки кофе и сон» (`analysis.js`), реплика `coffee_late`
(кофе после 16:00), цель «меньше кофе», колонка «Кофе / чай» в недельном отчёте, `cups` по дням в разборе недели ИИ.

### Подсказки из истории еды
Кодом на устройстве (`views/food.js`, `history()`): записи `food` за 60 дней группируются по тексту; вес — частота,
свежесть, тот же приём пищи. Показываются под полем ввода («Часто на завтрак»), при наборе — совпадения («Вы уже ели»).
Окно «Записать снова»: граммы каждого продукта (БЖУ пересчитываются пропорционально), убрать лишнее, приём пищи, время.
Избранное открывается тем же окном.

### Разгрузочная неделя
`workout.variant = 'deload'`: подходы × 0,6, время × 0,65, оригинал в `data.original`. `plan.applyDeloadWeek()` —
тренировки ближайших 7 дней без отметок; `plan.undoDeloadWeek()` — вернуть; `plan.deloadWeek()` → `{until, count}`.
Кнопка — на экране программы всегда, в тренировке и в день отдыха — когда `needsDeload()`.

### Режим ИИ
`profile.ai`: `'off'` или отсутствует/`'on'` (включена). Выключена — сервер отвечает 403 на задачи ИИ и чат,
еда считается только справочником. Задачи при спящей модели ждут в очереди: `{job_id, waiting: true}`,
статус задачи `queued` с `waiting`, отменённая заменой — `cancelled`; `/api/sync/head` → `{rev, ai}`.

## Витамины и добавки

Справочник `app/seed/supplements.json` (`GET /api/supplements`, на устройстве - meta `supplements`): `items[]` -
id, name, aliases, category, serving {amount, unit, label}, macros на порцию или null, dose {text, per_day_min/max, unit},
ul {value, unit, source} (безопасный верхний предел EFSA/IOM), timing, default_times, evidence A-D, claims[{text, level, source}],
about, cautions, contra, caffeine_mg, sleep_related, recommend (ключ правила совета, только у A/B), needs_test, sport_note;
`stoplist[]` - опасные и запрещённые вещества {name, aliases, why}.

- План: `profile.supplements: [{key, sid|null, name, dose, dose_unit, times[], custom?, active}]`; отказ от совета - `profile.supp_dismissed {key: дата}` (60 дней).
- Приём: запись `supp` (uuid) `{key, sid, name, time, dose, dose_unit, food_id?}`. У добавки с калориями (протеин, гейнер, изотоник)
  приём создаёт запись `food` с `calc: 'supp'`, `supp_id` - белок идёт в БЖУ дня везде; калории - по фактической дозе
  (граммы порции берутся из `serving.label`, «1 мерная ложка (30 г)»). Удаление любой из двух записей убирает и вторую.
- Проверки (`supps.js`): плановая дневная доза и факт за день против `ul`; противопоказания из `profile.limitations`;
  `needs_test`; лекарства в профиле; стоп-лист - только для своих добавок.
- Советы (`advice()`): только A/B и по данным: белок < 80 % нормы за неделю → протеин; цель мышцы/сила → креатин;
  октябрь-март → проверить витамин D; нагрузки > 75 мин → изотоник/электролиты; рыба < 2 раз за 3 недели → омега-3;
  вегетарианство → B12. При беременности советов нет. Всегда с оговоркой «не врач».
- Анализ: кофеин из добавок после 14:00 - в «кофеин и сон»; добавки `sleep_related` - сон после дней с приёмом и без
  (и улучшение, и ухудшение, с оговоркой «наблюдение, не доказательство»). Вечером (после 20:00) - реплика о неотмеченном плановом приёме.
- ИИ: добавки в `health_notes`, правила `userdata.SUPP_RULES` во всех промптах, в разборе недели - приёмы по дням и план.

## Короткие комплексы и предложения тренера

Модули `routine` (`plan.MODULES`): morning, workout, abs, legs, arms, back, stretch, cardio, neck, posture - равноправные
варианты на «Сегодня» (чипы, время на выбор; утренняя разминка ведёт в «Утро»). Упражнения - под инвентарь из профиля,
группы мышц - по `zones` (`requireZones`). Силовые и кардио-комплексы (`C.ROUTINE_LOAD`) засчитываются в недельный объём
по доле сделанного. Тренер (`today.suggestModule`, реплика `module_suggest` с кнопкой `td-mod-add`) предлагает один комплекс,
если сегодня его ещё нет: недобор недели → короткая тренировка (при низкой готовности - растяжка), далеко до нормы кардио →
кардио дома, включённые осанка/шея недобраны за неделю. Реплики тренера могут нести кнопку: `{act: {act, label, data}}`.

## Сон: несколько будильников

`sleep.alarm` - время первого будильника, `sleep.alarms` - сколько их было ('1'..'4', 4 = 4+). Сон до первого будильника
засчитывается полностью, дрёма до подъёма - наполовину (`sleepInfo.hours`; `inBed` - всё время в постели, `snoozeMin`);
штраф к качеству: 3 балла за каждый лишний будильник (до 9) и 1 балл за каждые 10 мин дрёмы сверх 20 (до 10).
Сервер считает так же (`jobs.sleep_hours_of`, `snooze_min`); в разборе недели - `snooze_min`, `alarms` по дням; в «Прогрессе» - средняя дрёма.
Импорт сна из «Здоровья» больше не затирает ответы человека к импортированной ночи.

## Список активностей
`today.activityRank()`: частота и свежесть отметок за 90 дней + активности из профиля + любимое кардио; группа «Ваши» (до 10) сверху.

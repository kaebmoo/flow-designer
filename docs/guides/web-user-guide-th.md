# คู่มือใช้งาน flow-designer ผ่านเว็บ

flow-designer คือ frontend เต็มรูปแบบสำหรับผู้ใช้งาน Atlas Control Plane
คุยกับ Atlas ผ่าน REST/SSE API เท่านั้น — ไม่มี domain state เป็นของตัวเอง —
และเพิ่มส่วนสร้าง workflow, การตัดสิน approval, การจัดการ trigger, การส่ง
delivery และรายงานข้าม run ที่
[ops console ที่ฝังมากับ Atlas](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/guides/web-user-guide-th.md)
ตั้งใจไม่ใส่ไว้

> Atlas ยังเป็น control plane และเป็น source of truth เพียงแหล่งเดียว
> flow-designer ดูแลแค่ presentation ทุก action ที่เห็นในหน้านี้สุดท้ายเรียก
> endpoint ของ Atlas และ Atlas ตรวจสิทธิ์ซ้ำที่ฝั่ง server เสมอ — บทบาทที่
> แสดงใน UI นี้เป็นเพียงตัวช่วยแสดงผล ไม่ใช่ตัวควบคุมสิทธิ์จริง

## Atlas console เทียบกับ flow-designer

ทั้งสอง frontend ยังใช้งานคู่กัน แต่ครอบคลุมคนละส่วน:

| ความสามารถ                                                              | Atlas embedded console                             | flow-designer                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Fleet: workers และ workspaces                                           | มี                                                 | มี (แยกเป็นสองหน้า)                                                                          |
| Live stream ต่อ job, ไทม์ไลน์เรียกเครื่องมือ, raw event, ไฟล์ที่เก็บไว้ | มีครบทั้ง 4                                        | มีเฉพาะ live event แบบ inline บน job ที่ยัง active ของ run — ไม่มีแท็บ timeline/events/files |
| ตัวแก้ไข workflow definition                                            | ไม่มี — ผ่าน API เท่านั้น                          | มี เป็น visual canvas แบบลากวาง                                                              |
| ติดตาม run + อนุมัติจากคน                                               | มี (ตัดสินผ่าน API)                                | มี (ตัดสินในหน้าเดียวกัน)                                                                    |
| Triggers                                                                | ไม่มี — ผ่าน API เท่านั้น                          | มี                                                                                           |
| Webhook deliveries                                                      | ไม่มี — ผ่าน API เท่านั้น                          | มี                                                                                           |
| Artifact ledger ทั้งระบบ (ทุก run)                                      | ไม่มี                                              | มี                                                                                           |
| Artifact ของแต่ละ run                                                   | มี ดาวน์โหลดได้อย่างเดียว                          | มี ดาวน์โหลดหรือ preview ในหน้าได้                                                           |
| อัปโหลดไฟล์เข้า run (เช่น PDF สัญญาให้ human gate ตรวจ)                 | ไม่มี — ผ่าน API เท่านั้น                          | ไม่มี — ผ่าน API เท่านั้น                                                                    |
| สั่งงานเดี่ยวแบบ ad-hoc / handoff                                       | ไม่มี — ผ่าน API เท่านั้น                          | ไม่มี — ผ่าน API เท่านั้น                                                                    |
| Import/export solution pack                                             | ไม่มี — ผ่าน API เท่านั้น                          | มีให้ใช้จากหน้า Workflows และ workflow editor                                                |
| Draft-from-plain-language, Explain, Repair, Suggest workers/triggers    | ไม่มี — ผ่าน API เท่านั้น                          | ไม่มี — ผ่าน API เท่านั้น                                                                    |
| การวัดการใช้งาน (Usage)                                                 | มี พร้อมกราฟ 7 วันและแจ้งเตือน quota               | มี ไม่มีกราฟ ไม่มีแจ้งเตือน quota                                                            |
| Audit log                                                               | มี กรองตามประเภทได้ แถวกดแล้วพาไปหา job/run/worker | มี เป็น log ธรรมดา ไม่มีตัวกรองตามประเภท แถวกดไม่ได้                                         |
| Users และ API tokens                                                    | มี                                                 | มี                                                                                           |
| Theme                                                                   | สลับ Light/Dark ได้                                | ไม่มี                                                                                        |

ควรเปิด Atlas console เดิมไว้อีกแท็บเมื่อจะติดตาม job ตัวใดตัวหนึ่งอย่างละเอียด
(ไทม์ไลน์เรียกเครื่องมือและ raw event log ของ Atlas ลงลึกกว่าหน้า Jobs ของ
flow-designer มาก) หรือจะตรวจสอบ usage เทียบ quota ส่วนเรื่องสร้าง รัน และ
ควบคุม workflow ทั้งหมดอยู่ที่นี่

## สิ่งที่ยังไม่มีใน UI — ต้องผ่าน API เท่านั้น

flow-designer ไม่มี UI สำหรับสิ่งต่อไปนี้เลย ยังต้องเรียกผ่าน REST API ของ
Atlas (ดู
[API Reference](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/specs/api-reference-th.md)):

- สั่งงานเดี่ยวแบบ ad-hoc นอก workflow พร้อม routing/handoff (`POST /api/jobs`)
- อัปโหลดไฟล์เข้า run เช่น สัญญาให้ human gate ตรวจ (`POST /api/workflow-runs/{id}/files`)
- Explain/Repair แบบ non-saving และ Draft-from-plain-language
  (`POST /api/workflows/{id}/explain|repair`, `POST /api/workflows/draft`)
- ตัวช่วย Suggest-workers / Suggest-triggers
  (`POST /api/workflows/suggest-workers`, `POST /api/workflows/{id}/suggest-triggers`)
- แผง "manager decision" ที่แสดง proposal และเหตุผลรับ/ปฏิเสธโดยเฉพาะ (ดูได้
  ผ่าน run events และ audit แทน — ดู §9)
- แนบไฟล์ binary ให้ start node ตั้งแต่ก่อนเริ่ม run เพราะ
  `POST /api/workflow-runs/{id}/files` ต้องมี run อยู่ก่อนแล้ว ดังนั้นฟิลด์
  `attachments` ใน JSON จึงเป็นข้อความหรือ metadata เท่านั้น ไม่ใช่การอัปโหลดไฟล์

## 1. เริ่มระบบ

สิ่งที่ต้องมีก่อน: Atlas ต้องรันอยู่แล้ว (ดูคู่มือของ Atlas เอง §1) และต้องมี
Bun เป็น package manager (`bun.lock` ถูก commit ไว้แล้ว)

```bash
cd /Users/seal/Documents/GitHub/flow-designer
bun install
bun run dev
```

ตั้งค่า environment variable อย่างน้อยเหล่านี้ใน `.env` (server-only ทั้งหมด —
ห้ามใส่ prefix `VITE_` เด็ดขาด เพราะจะทำให้ค่าหลุดไปอยู่ใน browser bundle):

| ตัวแปร             | ใช้ทำอะไร                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `ATLAS_API_ORIGIN` | origin ของ Atlas ที่เข้าถึงได้จาก server เท่านั้น เช่น `http://127.0.0.1:8787`                         |
| `SESSION_SECRET`   | ใช้ seal session cookie ของ flow-designer เอง ต้องยาวอย่างน้อย 32 ตัวอักษร (`openssl rand -base64 48`) |
| `PUBLIC_ORIGIN`    | origin สาธารณะของแอปนี้เอง เช่น `http://localhost:3000` ตอน dev บนเครื่อง                              |
| `SESSION_MAX_AGE`  | ไม่บังคับ; อายุ session cookie เป็นวินาที (ค่าเริ่มต้น 28800 = 8 ชั่วโมง)                              |

เปิด origin ตามที่ตั้งใน `PUBLIC_ORIGIN` (ค่าเริ่มต้นตอน dev บนเครื่องคือ
`http://localhost:3000`) แล้ว sign in

## 2. Sign in และ session

**Sign in** กรอก **Username** และ **Password** เพื่อยืนยันตัวตนกับ Atlas
ข้อความ error ระบุชัดเจนตามสาเหตุ: รหัสผิด ("Incorrect username or
password."), ถูก rate-limit (มีนับถอยหลังจริง เช่น "Atlas is rate limiting
login attempts. Try again in N second(s).") หรือ Atlas ติดต่อไม่ได้ ("Atlas
is unreachable right now. Try again in a moment.")

flow-designer สร้าง session cookie แบบ httpOnly ของตัวเองครอบ bearer token
ของ Atlas อีกชั้น — ตัว token เองไม่ถูกเปิดเผยให้ browser JavaScript เห็นเลย
(ต่างจาก Atlas console เดิมที่เก็บ token ไว้ใน `localStorage`)

จะมี banner ขึ้นเหนือหน้าเมื่อ session เหลือเวลาน้อยกว่าหรือเท่ากับ 5 นาที:
"Atlas session expires in N minute(s)." และเมื่อหมดอายุแล้ว: "Atlas session
expiry has passed; the next Atlas request will verify it." การออกจากระบบ,
การหมดอายุ หรือ quota สูงสุด 5 session ต่อผู้ใช้ของ Atlas ล้วนทำให้ session
จบได้ — banner ระบุชัดว่าอย่าอิงนาฬิกาของเบราว์เซอร์เพียงอย่างเดียว

ถ้า Atlas หยุดตอบสนองระหว่างที่ยังมีข้อมูลค้างอยู่บนจอ จะมี banner อีกอันขึ้น
ว่า "Atlas is not responding. Some data may be cached and stale; retry the
affected panel before acting on it."

**Sign out** (ที่ท้าย sidebar) ล้าง cache ทั้งหมดแล้วพากลับไปหน้า sign-in —
ตั้งใจให้เป็นแบบนี้เพื่อไม่ให้คนที่ sign in ต่อบนเบราว์เซอร์เดียวกันเห็นข้อมูล
ของผู้ใช้คนก่อน

## 3. การนำทาง

sidebar จัดกลุ่มทุกหน้าไว้ 4 กลุ่ม:

| กลุ่ม            | หน้า                                            |
| ---------------- | ----------------------------------------------- |
| **Operate**      | Dashboard, Workflows, Runs, Jobs, Triggers      |
| **Fleet**        | Workers, Workspaces, Conversations              |
| **Data & Audit** | Artifacts, Webhook Deliveries, Usage, Audit Log |
| **System**       | Users & Tokens, Settings                        |

sidebar ไม่มี badge นับจำนวนใด ๆ ทุกเมนูแสดงให้ผู้ใช้ที่ sign in แล้วเห็นเสมอ
ไม่ว่าจะมี role อะไร — หน้าที่ต้องการ role สูงกว่า (เช่น Users & Tokens) จะ
แสดงสถานะ forbidden แทนที่จะซ่อนลิงก์ไปเลย

## 4. Dashboard

หน้าแรก ("Mission Control") แสดง stat tile 4 อัน ดึงข้อมูลจาก
`GET /api/metrics` ของ Atlas:

| Tile                  | แสดงอะไร                                       |
| --------------------- | ---------------------------------------------- |
| **Workers Online**    | `online/total` หรือ "No workers registered"    |
| **Active Runs**       | จำนวนปัจจุบัน พร้อม run สะสมทั้งหมด            |
| **Workflows**         | จำนวน definition พร้อมจำนวน trigger ที่เปิดใช้ |
| **Approvals Pending** | human gate ที่กำลังรอการตัดสินใจ               |

Atlas ไม่มีตัวเลขสรุปอัตราสำเร็จรอบ 24 ชั่วโมงให้ role ใดเลย หน้านี้จึงไม่
แสดง (ระบุไว้ตรง ๆ บนหน้าแทนที่จะปั้นตัวเลขขึ้นมา) ใต้ tile มี **Recent Runs**
(5 รายการล่าสุด ลิงก์ไป **Runs**), **Fleet** (worker 5 ตัวล่าสุด ลิงก์ไป
**Fleet**) และ **Workflows** (grid 6 การ์ด ลิงก์ไป **Workflows**) ปุ่มเดียวที่
header คือ **View Workflows** — ตั้งใจไม่มีปุ่มลัด "New Workflow" ตรงนี้

## 5. ฟลีต: Workers และ Workspaces

Workers กับ Workspaces เป็นคนละหน้ากัน (ต่างจาก Atlas console เดิมที่รวมไว้
หน้าเดียวคือ **Fleet**)

### Workers

**Workers** แสดงชื่อ, Base URL, role, tags, เวอร์ชัน agent (หรือ "not
polled"), error ล่าสุด, สถานะ และเวลาที่เห็นล่าสุด การจัดการ worker
(เพิ่ม/แก้ไข/ลบ) ต้องใช้ role `admin` ของ Atlas ส่วนการ poll ใช้ `admin` หรือ
`operator` — ปุ่มที่กดไม่ได้จะบอกเหตุผลเสมอ (เช่น "Adding, editing, and
removing workers requires the Atlas admin role — yours is viewer.")

**Poll all** poll worker ทุกตัวทีละตัวตามลำดับ (มี banner บอกว่าไม่สามารถ
ยกเลิกระหว่างทำได้) แต่ละแถวมีปุ่มไอคอน: poll, edit, delete

ฟิลด์ของกล่อง **Register a worker** / edit: **Name**, **Base URL**, **Role**
(พิมพ์เอง), **Tags** (คั่นด้วย comma), **Worker token** (เว้นว่างตอนแก้ไขเพื่อ
คง token เดิม — Atlas ไม่ส่ง token คืนให้ browser) Atlas upsert worker โดยยึด
`base_url`: ถ้าสร้างใหม่ทับ URL ที่มีอยู่แล้วจะเตือนและให้เลือก overwrite
name/role/tags ของตัวเดิม แต่ถ้าแก้ไขไปชน URL ที่เป็นของ worker อื่นจะถูกบล็อก
ทันที

**Delete worker** จะ preview ก่อนว่ามี workspace ใดจะถูกลบตามไปด้วย (หรือ
ยืนยันว่าไม่มี) ก่อนที่ปุ่มลบจะกดได้

### Workspaces

**Workspaces** (`canManage` = `admin` หรือ `operator` ซึ่งกว้างกว่าเงื่อนไข
ของ Workers) แสดง workspace key, company, worker เจ้าของ (พร้อมสถานะ),
directory บนเครื่อง worker และ tags ฟิลด์ของกล่อง **Map workspace** / edit:
**Worker** (เลือกจาก dropdown), **Workspace key**, **Directory on the
worker**, **Company**, **Tags** — upsert โดยยึด `(worker, key)` ด้วยพฤติกรรม
ชนกัน/overwrite แบบเดียวกับ worker **Delete workspace** ระบุชัดว่าประวัติ job
ยังอยู่ครบ แค่จะไม่มีลิงก์ไปหา workspace ที่ถูกลบแล้วเท่านั้น

## 6. Conversations

**Conversations** เป็นแค่รายการจัดกลุ่ม/ติดป้ายแบบเบา ๆ — ไม่ใช่ช่องสั่งงาน
Atlas อาจใช้ session เดิมของ worker ซ้ำให้กับ conversation เมื่อ worker
รายงานว่ามี session อยู่ แต่หน้านี้สั่งงานไม่ได้

คอลัมน์: Conversation (id), Title, Workspace key, Company, Updated. **New
conversation** กรอก **Title** (บังคับ), **Workspace key (optional)** และ
**Company (optional)** ไม่มีปุ่มแก้ไขหรือลบ — Atlas ไม่มี endpoint แบบนั้นให้
conversation และรายการเองก็เป็นหน้าต่างคงที่แค่ 100 รายการล่าสุด ช่องกรอง
เป็นการกรองฝั่ง client เท่านั้น กรองเฉพาะที่โหลดมาแล้ว ไม่ได้ query Atlas
เพิ่มนอกหน้าต่างนั้น

## 7. Jobs

**Jobs** แสดง job ทุกตัวที่ Atlas บันทึกไว้ ไม่ว่าจะสั่งเองหรือมาจาก workflow
กรองด้วย **Workflow** (dropdown), สลับ **Group by workflow**, กรองด้วย chip
สถานะ (`all`, `queued`, `running`, `cancel_requested`, `succeeded`, `failed`,
`cancelled`) และเลือกหน้าต่าง (25/100/500)

คอลัมน์: Job, Prompt, Workflow (ลิงก์ run + node ถ้ามี), Worker, Workspace,
Created, Duration, State

กดแถวจะเปิด panel ด้านข้าง: สถานะ, ปุ่ม **Cancel job**, prompt เต็ม, ตาราง
ฟิลด์ (worker id, execution mode, model, session, started, duration), เหตุผล
การ routing, error (ถ้ามี) และ output ของ assistant โดย output นี้ระบุชัดว่า
เป็นผลลัพธ์ที่บันทึกไว้แล้ว — **ไม่มี live token streaming ในหน้านี้** จะเห็น
แบบ live เฉพาะแบบ inline ในหน้ารายละเอียดของ **Runs** สำหรับ job ที่อยู่หลัง
node ที่กำลัง run อยู่ (§9) หน้านี้ไม่มีแท็บ Stream/Timeline/Events/Files —
ถ้าต้องการรายละเอียดระดับนั้น (ไทม์ไลน์เรียกเครื่องมือ, raw event log, ไฟล์ที่
เก็บไว้) ให้ใช้
[Atlas console เดิม](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/guides/web-user-guide-th.md#4-งาน-ผลลัพธ์และเหตุการณ์)

**Cancel job** จะถามยืนยันก่อน ("Cancel job {id}?" / **Keep it running** /
**Request cancellation**) และบอกเหตุผลตรง ๆ เมื่อกดไม่ได้ (เช่น job จบไปแล้ว)

## 8. Workflows

### รายการ definition

**Workflows** แสดง definition ทุกตัว (name, description, status, จำนวน
node/edge, version, แก้ไขล่าสุด) **New workflow** สร้าง graph ที่เล็กที่สุดที่
ใช้งานได้จริงบน Atlas ทันที (worker node เดียว ไม่มี edge) แล้วเปิด editor
ให้เลย — ไม่มีขั้นตอน draft ฝั่ง client ก่อน

**Starter workflows** มีตัวอย่างพร้อมใช้ 4 แบบ กดครั้งเดียวสร้างได้เลย
(**Create example**): **Daily News Brief**, **Customer Complaint Handler**,
**Weekly Sales Report** และ **Blog Post Pipeline** (คนละชุดกับ template
ระดับ API ในตัวของ Atlas เอง 4 แบบ — News Desk, Researcher → Writer →
Reviewer, Coder → Tester → Reviewer และ Manager-directed loop — ซึ่งเรียกได้
เฉพาะผ่าน `GET /api/workflow-templates`)

ปุ่ม import/export solution pack อธิบายไว้ในหัวข้อ Workflow packs ด้านล่าง

### ตัวแก้ไข (editor)

เปิด definition แล้วจะเจอ visual canvas แบบลากวางของจริง — ไม่มีช่อง Graph
JSON ดิบให้แก้ที่ไหนใน flow-designer เลย มี palette ด้านซ้ายไว้เพิ่ม node
และ inspector ด้านขวาไว้แก้สิ่งที่เลือกอยู่ ปุ่ม **Delete** (ด้านบนของ editor)
ลบทั้ง definition หลังยืนยัน ("Delete "{name}"? Atlas removes the definition
and cascades its triggers and run history. This cannot be undone.")

node มี 4 ชนิด แต่ละชนิดแสดงบน canvas ด้วยชื่อภาษาธรรมดาแทนชื่อชนิดภายใน:

| ชนิดภายใน    | ป้ายบน canvas         | ทำหน้าที่อะไร                |
| ------------ | --------------------- | ---------------------------- |
| `worker`     | **AI Task**           | รันคำสั่งบน worker ที่ผูกไว้ |
| `manager`    | **AI Decision**       | เลือกว่าเส้นทางไหนจะทำงานต่อ |
| `join`       | **Wait for branches** | รอทุก branch ก่อนไปต่อ       |
| `human_gate` | **Human decision**    | หยุดรอการอนุมัติหรือการเลือก |

ฟิลด์ใน inspector แยกตามชนิด node:

- **AI Task** และ **AI Decision**: **Prompt** (แทนค่า `{input.x}`,
  `{artifact.key}`, `{run.x}`, `{node.x}`, `{job.x}` ได้), **Worker id**,
  **Workspace id**, **Role**, **Model**, **Company**, **Tags**, **Execution**
  (`stream` หรือ `callback`), **Budget units**, **Collect files** (glob
  pattern คั่นด้วย comma)
- **AI Task** เท่านั้น: **Output artifact key**, **Output format** (`text`
  หรือ `json`)
- **AI Decision** เท่านั้น: มีข้อความตายตัวว่าต้องคืนค่าเป็น
  `schema: manager_decision_v1` และทุก edge ขาออกต้องเป็น `manager_selected`
- **Wait for branches**: **Mode** (**All branches** / **Any branch** / **A
  set number of branches** คือ `all`/`any`/`quorum`) — ถ้าเลือก quorum จะมี
  ช่อง **Quorum** ให้กรอกตัวเลขเพิ่ม
- **Human decision**: ชื่อ section จะสลับระหว่าง **Request approval** กับ
  **Ask for a choice** ตามว่ามีการเพิ่ม choice หรือไม่ ฟิลด์: **Label**,
  **Reason**, รายการ **Choices** (**Add choice**, กรอก id/label ต่อรายการ,
  ปุ่มลบ) มีข้อความตายตัวว่า Atlas ไม่มีรายชื่อผู้อนุมัติต่อ gate และไม่มี
  deadline — ข้อจำกัดเวลาเดียวที่มีคือ `max_minutes` ของ workflow

ทุก node มีปุ่ม **Delete node** พร้อมยืนยันของตัวเอง

edge มีเงื่อนไข 6 แบบ พร้อมป้ายที่ canvas แสดงจริง:

| ชนิดภายใน              | ป้ายที่แสดง                         |
| ---------------------- | ----------------------------------- |
| `always`               | **Always**                          |
| `artifact_equals`      | **Artifact equals a value**         |
| `artifact_in`          | **Artifact is one of**              |
| `manager_selected`     | **Manager selected this path**      |
| `human_selected`       | **Person chose this option**        |
| `max_iterations_below` | **Node has run fewer than N times** |

edge ที่ออกจาก **AI Decision** เลือกได้แค่ **Manager selected this path**;
edge ที่ออกจาก **Human decision** ที่มี choice เลือกได้แค่ **Person chose
this option** — inspector จะเสนอเฉพาะตัวเลือกที่ถูกต้องตาม node ต้นทางเท่านั้น
ฟิลด์เฉพาะของแต่ละเงื่อนไข: **Artifact key** + **Path** (เงื่อนไขเกี่ยวกับ
artifact ทั้งคู่), **Equals** (`artifact_equals`), **One of** กรอกทีละบรรทัด
(`artifact_in`), dropdown **Choice** (`human_selected`), **Counted node** +
**Maximum runs** (`max_iterations_below`) ทุก edge ยังมีช่อง **Push files**
สำหรับส่งไฟล์ระหว่าง node ซึ่งจะกดไม่ได้จนกว่า switch `file_handoff` ใน
policy (ด้านล่าง) จะเปิด

**Run policy** (ปุ่มที่ sidebar ด้านซ้าย ไม่ใช่แท็บ — กดแล้วสลับ inspector)
เป็นฟอร์มล้วน ไม่มี JSON ดิบ:

- **Default reply**: **Workflow reply** (Absent / Explicit none / Webhook
  พร้อม **Callback URL** + **Correlation id** / Clear stored value)
- **Limits** — ใช้ชื่อฟิลด์จริงของ Atlas เป็นป้าย: **max_jobs** (จำนวน job
  สูงสุดที่ run สร้างได้), **max_iterations** (คุม cycle ของ graph — เป็นหนึ่ง
  ในสองวิธีที่อนุญาตให้มี loop), **max_attempts_per_node** (จำนวนครั้งที่
  retry ก่อนจะถือว่า node fail), **max_minutes** (เวลารวมสูงสุดของ run),
  **requires_human_after_iterations** (หยุดรอคนเมื่อ run วนครบจำนวนรอบนี้),
  **max_budget_units** (budget unit รวมสูงสุดที่ run ใช้ได้)
- **Switches**: **stop_on_first_failure**, **file_handoff** (ต้องเปิดก่อน
  **Push files** ของ edge ใด ๆ จึงจะมีผล)
- **Allow lists**: **allowed_worker_ids**, **allowed_workspace_ids** (คั่นด้วย
  comma)

ปุ่มใน toolbar (ข้อความจริง): **Auto-arrange**, **Save**/"Saving…", **Check
against Atlas**/"Checking…" (เรียก `POST /api/workflows/{id}/validate` ของ
Atlas) และ **Test run**/"Starting…" ไม่มีปุ่ม **Explain** และไม่มีปุ่ม
**Repair** รวมถึงไม่มี UI สำหรับ Draft-from-plain-language / Suggest-workers
เลย (ดู "สิ่งที่ยังไม่มีใน UI" ด้านบน)

### Application interface

**Application interface** (ปุ่มที่ sidebar ด้านซ้าย ถัดจาก **Run policy** —
กดแล้วสลับ inspector แบบเดียวกัน) ใช้สร้าง `interface` ที่เป็นทางเลือกและเป็น
authoritative ต่อ workflow ของ Atlas เอง: input schema ที่เก็บไว้จริง ตัวอย่าง
sample สังเคราะห์ และ public output ที่ผู้เรียกจากภายนอกอ้างอิงได้ workflow ที่
ไม่มี interface จะไม่ได้รับผลกระทบใด ๆ — ทุกอย่างด้านล่างนี้เป็น opt-in ทั้งหมด

- **input_schema** — ช่องแก้ไข JSON ดิบสำหรับ profile แบบมีขอบเขตของ Atlas ที่
  คล้าย JSON Schema: ชนิด `object`/`array`/`string`/`number`/`integer`/
  `boolean`/`null`, `properties`/`required`/`additionalProperties`/`items`/
  `enum`/`const`, คีย์เวิร์ด `min`/`max` และฟิลด์อธิบายเฉย ๆ `title`/
  `description`/`default`/`examples` ไม่มี `$ref` ไม่มี
  `oneOf`/`anyOf`/`allOf`/`not` ไม่มี `pattern` หรือ `format` root ต้อง
  ประกาศ `type: "object"` เป๊ะ ๆ (หรือรูปแบบสมาชิกเดียวที่เท่ากันคือ
  `type: ["object"]`) — union ที่เป็น nullable หรือผสมชนิดอย่าง
  `["object","null"]` จะถูกปฏิเสธ และกฎเดียวกันนี้ใช้กับทุก object segment บน
  path ที่ **start** node ของ graph render diagnostic ฝั่ง local จะขึ้นระหว่าง
  พิมพ์ แต่การตรวจสอบตอน save ฝั่ง Atlas เองเป็นคำตัดสินสุดท้ายเสมอ
- **sample_input** — ช่องแก้ไข JSON ดิบสำหรับตัวอย่างเชิงเอกสาร/ทดสอบ มีคำเตือน
  ชัดเจนว่าค่านี้ถูกเก็บไว้ในตัว workflow จริง (และอาจติดไปกับ pack export ด้วย)
  จึงต้องเป็นข้อมูล **สังเคราะห์เท่านั้น** — ห้ามใส่ชื่อจริง เลขบัตรประชาชน
  ข้อมูลติดต่อ credential หรือ API key
- **Public outputs** — ตารางของ output key ที่ worker node ใน graph ปัจจุบัน
  สามารถผลิตได้ แต่ละแถวมี checkbox, title (ไม่บังคับ) และ description (ไม่
  บังคับ) จะประกาศได้เฉพาะ key ที่ผลิตโดย worker node เดียวเท่านั้น ส่วน key ที่
  มีมากกว่าหนึ่ง node ผลิตจะถูกปิดใช้งาน (disabled) เพราะ Atlas บังคับความไม่ซ้ำ
  นี้ output ที่ประกาศไว้เลือกได้หนึ่งตัวให้เป็น **primary_output** — เป็นเพียง
  คำแนะนำให้ผู้เรียกภายนอก ไม่ใช่ข้อบังคับตอนรัน
- **Clear** ลบ interface ทั้งหมดออก (Atlas จะได้ค่า `null` แบบชัดเจน ไม่ใช่แค่
  เว้นฟิลด์ว่างไว้); **Add interface** ใช้เริ่มสร้างใหม่
- ถ้า schema ที่ประกาศไว้กับการใช้งาน `{input.x}`/output จริงใน graph ไม่ตรงกัน
  — เช่น path ของ start node ที่ schema ไม่รองรับ หรือ output ของ worker ที่
  interface ไม่เคยประกาศไว้ — จะมีคำเตือน drift ระบุ path, node หรือ output ที่
  ไม่ตรงกันนั้นตรง ๆ ทั้งสองฝั่งจะไม่ถูกแก้ให้อัตโนมัติ การตรวจไขว้ (cross-check)
  ตอน save ของ Atlas เองยังเป็นเส้นแบ่งสุดท้าย
- interface ที่ถูก save ไว้โดย flow-designer เวอร์ชัน **ใหม่กว่า** ด้วย
  `schema_version` ที่ build นี้ไม่รู้จัก จะแสดงเป็น **read-only** พร้อม JSON
  ดิบให้ดู — การ Save จะไม่เข้ารหัสใหม่หรือทิ้งข้อมูลนั้นไปเงียบ ๆ

### Test run

กด **Test run** แล้วจะเปิด dialog ขึ้นมา การเปิด dialog ไม่ได้เริ่ม run ใด ๆ
เป็นเพียงการอ่าน graph ที่ save ไว้ และ `interface` ที่ save ไว้ (ถ้ามี) ป้าย
กำกับในแท็บ Integration จะบอกว่ากำลังทำงานในโหมดไหน:

- **Declared · enforced by Atlas** — workflow มี interface แบบ
  `schema_version: 1` แท็บ Input JSON จะถูกกรอกล่วงหน้าจาก `sample_input` ที่
  เก็บไว้ (หรือ `{}` ถ้าไม่ได้ตั้งไว้) ค่าที่พิมพ์เข้าไปจะถูกตรวจสอบกับ
  `input_schema` ที่เก็บไว้ในเครื่องทันทีเพื่อ feedback ที่รวดเร็ว และจะมี
  ตัวเลขประมาณขนาดใกล้ 1 MiB แสดงเป็นข้อความแจ้งเตือนที่ไม่บล็อกอะไรด้วยตัวเอง
  — Atlas เป็นผู้วัด effective input จริง (หลัง merge `default_reply` ถ้ามี)
  และเป็นผู้ตัดสินสุดท้าย **Start test run** จะส่ง
  `{ input, expected_workflow_version }` โดยปักเวอร์ชันไว้ที่เวอร์ชัน workflow
  ตอนที่เปิด dialog นี้ Atlas จะตอบ **400** พร้อมระบุ field/path เมื่อ business
  input ผิด และตอบ **409** เมื่อเวอร์ชันเก่าไปแล้ว ทั้งสองกรณี dialog จะยังเปิด
  ค้างพร้อม payload เดิม — ไม่มีการ retry ให้อัตโนมัติทั้งคู่ แท็บ Integration
  จะสร้างคู่มือ cURL/TypeScript/Python ที่ copy ได้ปลอดภัยจาก contract ที่
  ประกาศไว้จริง รวมทั้งเวอร์ชัน workflow และ Atlas commit ขั้นต่ำที่รองรับ
- **Observed · not enforced by Atlas** — ไม่มี interface ที่ใช้งานได้ถูกเก็บไว้
  (ไม่มีเลย หรือไม่เคยประกาศไว้) ไม่เปลี่ยนจากเดิม: ช่องพิมพ์ JSON ดิบ พร้อม
  ตัวอย่างที่สร้างจาก path `{input.x}` ที่ graph ที่ save ไว้อ้างถึงจริง ค่า
  ตัวอย่างเป็น placeholder (`"<input.topic>"`) ที่แสดงรูปร่างเท่านั้น ไม่ใช่
  ชนิดข้อมูลหรือค่า default path ที่ prompt ของ **start** node render ถ้าขาด
  ไปจะเป็น error แบบ **บล็อก** (Atlas จะทำให้ run ล้มทันที) ส่วน path ที่มีแต่
  node ถัดไปหรือ node ตามเงื่อนไขใช้ จะเป็นเพียง **คำเตือน** เพราะ node นั้นอาจ
  ไม่ถูกเรียกเลย `{}` ใช้ได้เสมอ ส่วน root ที่ไม่ใช่ object หรือ JSON ที่ผิด
  รูปแบบจะถูกปฏิเสธ

ตั้งแต่ Atlas แก้ manager-prompt-parity แล้ว prompt ของ node **AI Decision**
(manager) จะถูกแทนค่าเหมือนกับของ **AI Task** ทุกประการ: `{input.x}` ใน
prompt ของ manager เป็น reference ที่ใช้งานจริง และกฎบล็อก/เตือนของโหมด
Observed ก็ใช้กับมันแบบเดียวกัน — manager ที่เป็น **start** node แล้วขาด path
ที่อ้างถึงจะบล็อก ส่วน manager ที่อยู่ถัดไปจะได้แค่คำเตือน

สิ่งที่พิมพ์ในทั้งสองโหมดไม่ถูกบันทึกไว้ที่ใดเลย ไม่ว่าจะในเบราว์เซอร์ ใน URL
หรือในตัวอย่างที่ copy/download ออกไป

กด **Start test run** จะสร้าง run จริงบน Atlas: worker ทำงานจริง มีการใช้ budget
units จริง และ reply webhook ที่ตั้งไว้จะถูกส่งจริง ไม่มีโหมดทดลองแบบไม่ทำงานจริง
จากนั้นหน้าจะพาไปยังหน้ารายละเอียดของ run นั้นด้วย id จริง `wfr_…` ถ้า Atlas
ปฏิเสธ ข้อความจะยังอยู่บนจอพร้อมกับ payload เดิม

ถ้าออกจาก editor ทั้งที่ยังไม่ได้ save จะมีข้อความถาม **Discard unsaved
workflow changes?** (**Keep editing** / **Discard changes**) มี banner
กู้คืนงานที่ยังไม่ได้ save ("Restore draft" / "Discard") ไว้กู้คืนงานแก้ไข —
รวมถึงงานแก้ไข **Application interface** ที่ยังไม่ได้ save ด้วย — จากแท็บ
เบราว์เซอร์เดิมหลังเผลอออกจากหน้าหรือ reload เป็นการกู้คืนฝั่ง local เท่านั้น
ไม่เกี่ยวกับฟีเจอร์ AI draft แต่อย่างใด

### Workflow packs

ที่หน้า Workflows ปุ่ม **Import pack** จะอ่านไฟล์ `.json` ใน browser และแสดง preview ก่อนติดต่อ
Atlas: ชื่อ/เวอร์ชัน pack, ชื่อ workflow, จำนวน trigger และสถานะ signed/unsigned ไฟล์ที่ใหญ่กว่า
5 MiB และ JSON ที่อ่านไม่ได้จะถูกปฏิเสธใน browser ส่วน schema version ที่ไม่ใช่ 1 จะแสดงเป็นคำเตือน
แล้วปล่อยให้ Atlas เป็นผู้ตัดสินเมื่อกดส่ง

การ import ต้องมี permission `workflows.manage` ของ Atlas และจะสร้าง workflow แถวใหม่เสมอ — ไม่ใช่
การ restore, overwrite หรือ merge ของเดิม เมื่อสำเร็จจะแสดงลิงก์ไปยัง workflow ที่สร้างใหม่ เมื่อ
Atlas ปฏิเสธ dialog จะยังเปิดพร้อม bundle เดิมเพื่ออ่านข้อความจาก Atlas และการปิด dialog จะล้างไฟล์
กับ preview ที่เลือกไว้

ในหน้า workflow editor ปุ่ม **Export pack** จะดาวน์โหลดไฟล์รูปแบบ
`<workflow-name-slug>.pack.json` ที่จัด JSON ให้อ่านง่าย ภายในมี graph, policy, interface (รวม
`sample_input` ที่เป็นข้อมูลสังเคราะห์) และ triggers แต่ **ไม่มี `default_reply`** ใน pack ห้ามใส่ข้อมูล
ผู้ใช้จริงหรือข้อมูลลับใน sample input และ trigger config

## 9. Runs

### รายการ

**Runs** แสดง workflow run ทุกตัว: id, workflow (ลิงก์), created, started,
duration, state กรองด้วย chip สถานะ (`all`, `running`, `queued`, `paused`,
`waiting_for_human`, `recovery_required`, `succeeded`, `failed`,
`cancelled`) และหน้าต่าง (25/100/500)

### รายละเอียด

เปิด run แล้วจะเห็นตามลำดับนี้:

- **แผงกู้คืน** (แสดงเฉพาะเมื่อเกี่ยวข้อง): node ที่ค้าง, job ของมัน, จำนวน
  attempt และ callback ยังค้างอยู่ฝั่ง worker หรือไม่
- **Run control**: **Pause**, **Resume** หรือ (สำหรับ `recovery_required`)
  **Authorize retry & resume** (หน้ายืนยันเตือนตรง ๆ ว่า Atlas จะสร้าง job
  **ใหม่** ต่อ node ที่ค้างแต่ละตัว ไม่ใช่การเชื่อมกลับเข้า job เดิม)
  **Cancel** มีหน้ายืนยันของตัวเอง ปุ่มยกเลิกของทุกหน้ายืนยันใช้ข้อความ
  **Leave it alone**
- **Run graph**: canvas แบบดูอย่างเดียวของ graph snapshot ที่ freeze ไว้
  (ไม่ใช่ definition ที่แก้ไขได้จริง) มีป้าย "start" ที่ node ต้นทาง สีขอบของ
  แต่ละ node สะท้อนสถานะ runtime (running/waiting/succeeded/failed หรือ
  interrupted/skipped) ส่วน edge ที่ตรงกับเส้นทางจริงที่ Atlas เดินจะวาดหนา
  กว่าและใช้สี accent
- **Live job events**: แบบ inline เฉพาะ job ที่อยู่หลัง node ที่กำลัง run
  แสดง phase ตรง ๆ: connecting, streaming, stale, reconnecting (พร้อมจำนวน
  attempt และเวลารอ), closed หรือถ้าล้มเหลว: disconnected, session expired,
  access denied, job not found สตรีมพร้อมกันได้สูงสุด 4 ตัว log ที่แสดงถูก
  จำกัดจำนวนพร้อมข้อความบอกว่ามีเก็บสำรองไว้อีกเท่าไร
- **Run input**: payload ที่ Atlas เก็บไว้จริงสำหรับ run นี้ ถูกพับเก็บไว้หลัง
  "Show the input this run was started with" มีคำเตือนเรื่องข้อมูลส่วนบุคคล/
  ข้อมูลอ่อนไหว เพราะเป็นข้อมูลของผู้เรียกเอง จำกัดที่ 32,000 ตัวอักษร (มีข้อความ
  บอกเมื่อถูกตัด) และแสดง **เฉพาะที่นี่** เท่านั้น ไม่ปรากฏในรายการ Runs
  รวมถึง `_meta` ที่เป็นซองสงวนของ Atlas ซึ่งเป็นที่ตั้งค่า reply webhook
  ถ้า run เริ่มโดยไม่มี input เลย ส่วนนี้จะไม่แสดง
- **Application interface**: เวอร์ชันของ workflow และ interface
  `schema_version` ที่ run นี้เริ่มทำงานด้วยจริง ถูก freeze ไว้ตั้งแต่ตอนสร้าง
  run — ไม่ใช่การอ่านซ้ำจาก workflow definition ที่ยังใช้งานอยู่ปัจจุบัน ซึ่ง
  อาจถูกแก้ไขหรือลบไปแล้วก็ได้ ส่วนที่พับเก็บไว้จะโชว์ `input_schema` และ
  output ที่ประกาศไว้ (มีป้าย primary) ที่ run นี้ถูกประกาศไว้กับมันแบบเป๊ะ ๆ
  run ที่ไม่มี interface snapshot — ไม่ว่าจะเป็น run เก่าหรือ run ของ workflow
  ที่ไม่เคยมี interface เลย — จะระบุตรง ๆ ว่าไม่มี contract ที่เป็นทางการให้ดู
  แทนที่จะเดาจากสถานะปัจจุบันของ workflow
- ตาราง **Runtime nodes** (node, job, attempt, duration, error, state) และ
  ตาราง **Runtime edges** (from, to, เงื่อนไขตรงหรือไม่)
- **Approvals**: หนึ่งแถวต่อ gate ที่ไปถึง มีปุ่ม **Approve** (หรือปุ่มต่อ
  choice) และหน้ายืนยัน **Reject** ("Reject this gate and fail the run?" /
  **Reject and fail the run**) gate ที่ตัดสินแล้วจะโชว์เวลา ตัดสินซ้ำครั้งที่
  สองไม่ได้ ไม่มีแผง "manager decisions" แยกต่างหาก — ผลของ manager node
  จะโผล่เหมือน node ทั่วไปใน Runtime nodes/บน canvas โดยมีป้ายว่า **AI
  Decision**
- **Artifacts**: key, kind, size, created และปุ่ม **Download** หรือ
  **Preview** (ไม่มีทั้งสองพร้อมกัน — artifact ชนิด `file_ref` ดาวน์โหลด
  ส่วนชนิดอื่น preview ในกล่องโต้ตอบที่จำกัดไว้ 32,000 ตัวอักษรแรก) key ที่
  interface snapshot ของ run นี้เองประกาศไว้เป็น public output จะมีป้าย
  **declared** (มี **· primary** ต่อท้ายเมื่อเป็น primary output) ส่วน key ที่
  มีแต่ worker node ใน graph snapshot เป็นผู้ผลิต โดยไม่มี interface ประกาศไว้
  จะมีป้าย **observed** แบบเดิมแทน — เกิดขึ้นได้ทั้งสองแบบ ไม่ได้รับประกันแบบ
  ใดแบบหนึ่ง artifact ที่ถูกเขียนขึ้นระหว่างเปิดหน้าอยู่จะขึ้นมาเอง — ตารางจะ
  refresh เมื่อ live event บอกว่ามีการเปลี่ยนแปลง และอีกครั้งเมื่อ run เข้าสู่
  สถานะสุดท้าย ผลลัพธ์ของ test run จึงไม่ต้อง reload หน้า
  **ตรงนี้ไม่มีช่องอัปโหลด** — การแนบไฟล์เข้า run (เช่น สัญญาให้ human gate
  ตรวจ) ต้องผ่าน API เท่านั้น (`POST /api/workflow-runs/{id}/files`)
- **Webhook delivery attempts** ของ run นี้ มีปุ่ม **Send webhook now** และ
  ปุ่ม **Retry webhook** บนแถวที่เป็น `failed`/`blocked` (ดูหน้า Deliveries
  เต็ม ๆ ที่ §11)
- **Run events**: ตารางแบ่งหน้า (seq, at, event, node, payload) พร้อมปุ่ม
  **Load more events** สำหรับประวัติที่เก่ากว่า

## 10. Triggers

**Triggers** แสดงเป็นตาราง (ไม่ใช่การ์ด): Trigger (name/type/id), Starts
(workflow ที่ลิงก์ไว้), Configuration (สรุปย่อ; แถวของ webhook จะโชว์ path
`POST /api/workflow-triggers/{id}/fire` ตรง ๆ พร้อมปุ่มคัดลอก), Fired
(ครั้งล่าสุด/ครั้งถัดไป), Last event (status pill เดียวพร้อม error ถ้ามี —
ไม่มีรายการ event history ให้ขยายดู ต่างจากการ์ด trigger ของ Atlas เอง),
Enabled (switch) และปุ่มต่อแถว: Fire, Edit, Delete

trigger มี 6 ชนิดเหมือนกับฝั่ง API ของ Atlas: `manual`, `schedule`,
`webhook`, `workflow_run_completed`, `artifact_created`,
`worker_status_changed` กล่อง **New trigger** / **Edit trigger** เป็นฟอร์ม
ล้วน ไม่มีช่อง Config JSON ดิบ:

| ชนิด                     | ฟิลด์                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `schedule`               | **Every N minutes** หรือ **Once a day at** (ระบุชัดว่าใช้นาฬิกาของเครื่อง Atlas ไม่ใช่ของเบราว์เซอร์)                                      |
| `workflow_run_completed` | **Source workflow** ("Any workflow"), **Run state** ("Any state" / succeeded / failed / cancelled)                                         |
| `artifact_created`       | **Source workflow**, **Artifact key** ("Any key"), **Artifact kind** ("Any kind" / text / json / markdown / file_ref / summary / decision) |
| `worker_status_changed`  | **Worker** ("Any worker"), **New status** ("Any status" / online / offline)                                                                |
| `webhook`                | ไม่มีฟิลด์ — โชว์ path สำหรับ fire แบบตายตัวแทน                                                                                            |
| `manual`                 | ไม่มีฟิลด์ — fire ได้เฉพาะจากปุ่ม Fire หรือเรียก API ตรง ๆ                                                                                 |

การลบ trigger จะเตือนว่าลบประวัติการ fire ทั้งหมดไปด้วย (run ที่ trigger เคย
เริ่มไว้แล้วยังอยู่เหมือนเดิม) ไม่มีตัวช่วย Suggest-triggers

## 11. Webhook Deliveries

**Webhook Deliveries** แสดงรายการส่ง webhook ขาออกที่ Atlas ทำหลัง workflow
run จบ: Delivery ID, Run (ลิงก์), Target URL, Attempts (`n/max`), Last
error, Status สถานะมี 4 แบบ: `pending`, `delivered`, `failed`, `blocked`
กรองด้วย chip สถานะ หรือกรองด้วย run id ("Filter by run id (applied by
Atlas)") ปุ่ม **Retry webhook** มีให้เฉพาะแถว `failed`/`blocked` และเฉพาะ
role `admin`/`operator` (Atlas ยังบังคับสิทธิ์นี้ที่ฝั่ง server เสมอไม่ว่าปุ่ม
จะแสดงอย่างไร)

## 12. Artifacts

**Artifacts** คือ ledger ข้าม run ทั้งหมด อิงจาก `GET /api/artifacts` ของ
Atlas — artifact ของทุก run รวมในรายการเดียวเรียงใหม่สุดก่อน เป็น
metadata-only (ไม่แทรกเนื้อหา artifact ไว้ในรายการเลย) กรองด้วย chip ชนิด
(`text`, `json`, `markdown`, `file_ref`, `summary`, `decision`), ด้วย run
id, job id หรือ key และเลือกหน้าต่าง (25/100/500) คอลัมน์: Key, Kind,
Produced by (ลิงก์ไป run หรือโชว์ job id), Size, Created และปุ่ม
**Download** หรือ **Preview** เหมือนแผง Artifacts ของแต่ละ run ทุกประการ (§9)

ท้ายหน้าระบุชัดว่ารายการนี้เป็นแค่หน้าต่างของทั้งหมด ในขณะที่แผง Artifacts
ของ run แต่ละตัวเอง (§9) จะครบทุกรายการเสมอ ไม่ถูกตัดทอน

## 13. Usage & Metering

**Usage & Metering** อ่านจาก usage ledger แบบ append-only ของ Atlas เลือก
**From**/**To** (รวมวันที่ระบุ) หรือเว้นว่างทั้งคู่เพื่อดูย้อน 30 วันล่าสุด —
Atlas ไม่จำกัด endpoint นี้เลย ถ้าไม่ใส่ช่วงจะได้ ledger ทั้งหมด และหน้านี้ก็
ระบุไว้ตรง ๆ

Tile 4 อัน: **Workflow runs** (พร้อมจำนวนที่สำเร็จ), **Jobs** (พร้อมเวลารวม
ของ job), **Budget units** (พร้อมเวลารวมของ run), **Tokens** (prompt/output
ตามที่ worker รายงาน) ใต้ tile มีบรรทัดประมาณการต้นทุน ระบุชัดว่า "เป็นตัวเลข
ประมาณการเพื่อการมองเห็นที่ Atlas freeze ไว้ตอนบันทึก ไม่ใช่บิลเรียกเก็บ" —
Atlas วัดการใช้งานเท่านั้น ไม่คิดราคา ไม่ออกใบแจ้งหนี้ ไม่บังคับ quota
**หน้านี้ไม่มีกราฟและไม่มีแจ้งเตือน quota/threshold** — ต่างจากหน้า Usage ของ
Atlas เองที่มีทั้งคู่

ตาราง event (kind, status, units, tokens, est. cost, run/job, actor) แสดง
สูงสุด 200 แถวแม้จะมีมากกว่านั้น; ปุ่ม **Export CSV** จะได้ข้อมูลเต็มทั้งช่วง
เสมอ

## 14. Audit Log

**Audit Log** แสดงเป็น log แบบ monospace ไม่ใช่ตาราง: timestamp, `[actor]`,
action, `→ resource` และรายละเอียด — ไม่ได้จัดเป็นคอลัมน์ กรองด้วยหน้าต่าง
(25/100/500) และช่วงวันที่ **ไม่มีตัวกรองตามประเภท action** (job/workflow/
worker/approval) และ **แถวกดไม่ได้** — ทั้งสองอย่างนี้เป็นสิ่งที่หน้า Audit
ของ Atlas เองมีเพิ่มมาต่างหาก (ดูคู่มือนั้น §6) ปุ่ม **Export CSV** ครอบคลุม
ทั้งช่วงที่กรองไว้

## 15. Users & Tokens

หน้านี้เฉพาะ admin เท่านั้น role อื่นจะเห็นสถานะ forbidden **Create user**
กรอก **Username**, **Password**, **Role** (`admin`, `operator`, `viewer`,
`auditor`) และ **Status** (`active`, `disabled`) — ไม่มีปุ่ม "suspend" แยก
ต่างหาก มีแค่ฟิลด์ status นี้

ต่างจาก Atlas console เดิม การแก้ไขหรือลบบัญชีตัวเองที่นี่ **ไม่ถูกบล็อกแบบ
แข็ง** เลย — ใช้วิธีเตือนแทน ("This is your own account: demoting or
disabling it takes effect on your next request and can lock you out of this
page" / "...deleting it revokes the session you are using right now")

**API tokens**: **Mint token** กรอก **User**, **Token name** และ **Expiry**
(UTC, ไม่บังคับ) ค่า token ที่สร้างจะแสดงครั้งเดียวเท่านั้น — "Atlas stores
only a hash, so this value cannot be shown again — not after closing this
dialog, not after a reload" พร้อมปุ่ม **Copy** และปุ่มปิด **Done — discard
the value** เปลี่ยนชื่อหรือเพิกถอน token ทีหลังได้ ถ้าเพิกถอน token ที่กำลัง
ใช้ยืนยัน session อยู่ session นั้นจะถูกออกจากระบบทันทีในคำขอถัดไป

## 16. Settings

**Settings** ตั้งใจให้แทบว่างเปล่า: มีแค่ 3 แถวข้อมูลอย่างเดียว (เวอร์ชัน
Atlas, เวอร์ชัน schema, เวลาของ server) ดึงจาก `GET /api/metrics` พร้อม
ข้อความสั้น ๆ อธิบายว่า Atlas ไม่มี settings API ที่ยืนยันตัวตนได้ จึงไม่มี
อะไรให้ตั้งค่าเพิ่มเติมที่นี่ — ไม่มีปุ่มสลับธีม ไม่มีหน้าแก้โปรไฟล์ (หน้านี้
เวอร์ชันก่อนหน้าเคยโชว์ hostname/TLS/integration ที่แต่งขึ้นเอง ถูกลบออกแล้ว
เพราะไม่ใช่ของจริง) flow-designer ไม่มีปุ่มสลับ light/dark theme เลยที่ไหน
ต่างจาก Atlas console เดิม

## 17. แก้ปัญหา

| อาการ                                                                       | สิ่งที่ต้องตรวจ                                                                                                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ค้างที่ "Signing in" หรือขึ้นข้อความ rate-limit ซ้ำ ๆ                       | รอตามเวลานับถอยหลังที่แสดง Atlas จำกัดจำนวนครั้ง login                                                                                                               |
| banner หมดอายุ session ขึ้นระหว่างทำงาน                                     | บันทึกงานที่ทำค้างไว้ก่อน แล้ว sign in ใหม่เมื่อหมดอายุจริง — quota 5 session อาจทำให้ session นี้ถูกเบียดออกจากที่อื่นด้วย                                          |
| banner "Atlas is not responding"                                            | Atlas ติดต่อไม่ได้ ให้ลอง retry panel ที่ได้รับผลกระทบเมื่อ Atlas กลับมา แทนที่จะเชื่อตัวเลขที่ค้างอยู่บนจอ                                                          |
| หน้าใดหน้าหนึ่งแสดงสถานะ forbidden                                          | role ของผู้ใช้ที่ sign in ไม่มีสิทธิ์เข้าถึง — เช่น Users & Tokens เฉพาะ admin เท่านั้น                                                                              |
| Workflow กด Run ไม่ได้                                                      | แก้รายการใน Checks ของ editor ให้ครบก่อน แล้วค่อย **Save** แล้วค่อย **Test run**                                                                                     |
| ต้องส่งค่า run input (`{input.x}`)                                          | ใช้ปุ่ม **Test run** แล้วกรอกในแท็บ Input JSON — ดู §8                                                                                                               |
| ปุ่ม **Start test run** กดไม่ได้                                            | JSON ผิดรูปแบบ หรือ root ไม่ใช่ object หรือขาด path ที่ start node ต้องใช้ — ข้อความเหนือปุ่มจะบอกว่าเป็นกรณีไหน                                                     |
| ต้องแนบไฟล์เข้า run หรือสั่งงานเดี่ยวแบบ ad-hoc                             | ทั้งสองอย่างต้องผ่าน API เท่านั้นในตอนนี้ ดู [API Reference](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/specs/api-reference-th.md)                |
| ต้องดีบัก job รายตัวแบบละเอียด (เรียกเครื่องมือ, raw event, ไฟล์ที่เก็บไว้) | ใช้ [Atlas console เดิม](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/guides/web-user-guide-th.md#4-งาน-ผลลัพธ์และเหตุการณ์) แทนหน้า Jobs ของแอปนี้ |

สำหรับแนวคิดพื้นฐานของ Atlas (node type, join mode, condition, artifact
kind, policy field, trigger type) ดู
[Concepts & Reference (ไทย)](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/concepts-th.md)
ส่วน API ทั้งหมด ดู
[API Reference](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/specs/api-reference-th.md)

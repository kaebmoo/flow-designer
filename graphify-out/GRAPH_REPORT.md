# Graph Report - . (2026-07-20)

## Corpus Check

- 121 files · ~53,972 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary

- 842 nodes · 1303 edges · 102 communities (46 shown, 56 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 47 edges (avg confidence: 0.66)
- Token cost: 112,323 input · 0 output

## Community Hubs (Navigation)

- Atlas API & Auth Server
- Workflow Editor & Simulator
- Architecture & Governance Docs
- ESLint & Dev Dependencies
- Router & Route Tree
- Atlas Error/Identity Mappers
- TypeScript & Vite Config
- Sidebar UI Component
- Overlay & Input Primitives
- Button & Badge Primitives
- List/Table Route Pages
- Dashboard & Run/Workflow Pages
- shadcn Registry Config
- Package Manifest & Scripts
- Command & Dialog UI
- Menubar UI Component
- Form UI Component
- SSR Server Entry & Errors
- Runtime UI Dependencies
- Carousel UI Component
- Usage & Workspaces Pages
- Chart UI Component
- Context Menu UI
- Dropdown Menu UI
- Root Shell & Lovable Reporting
- Alert Dialog UI
- Sheet UI Component
- Table UI Component
- React UI Hooks
- Breadcrumb UI Component
- Drawer UI Component
- Navigation Menu UI
- Select UI Component
- Card UI Component
- Toggle & Toggle Group
- Input OTP UI
- Settings Route Page
- Users Route Page
- Accordion UI Component
- Avatar UI Component
- Tabs UI Component
- Jobs Route Page
- Toast Notifications (Sonner)
- class-variance-authority
- clsx
- date-fns
- embla-carousel-react
- @hookform/resolvers
- input-otp
- Radix Accordion
- Radix Alert Dialog
- Radix Aspect Ratio
- Radix Avatar
- Radix Collapsible
- Radix Context Menu
- Radix Dialog
- Radix Dropdown Menu
- Radix Hover Card
- Radix Label
- Radix Menubar
- Radix Navigation Menu
- Radix Popover
- Radix Radio Group
- Radix Scroll Area
- Radix Select
- Radix Separator
- Radix Slider
- Radix Switch
- Radix Tabs
- Radix Toggle
- Radix Toggle Group
- Radix Tooltip
- react-day-picker
- react-dom
- react-hook-form
- recharts
- sonner
- tailwind-merge
- tailwindcss
- @tailwindcss/vite
- TanStack Query
- TanStack Router
- TanStack Start
- TanStack Router Plugin
- tw-animate-css
- vaul
- vite-tsconfig-paths
- React Flow (@xyflow)
- zod
- zustand
- Input Component
- Separator Component
- Skeleton Component
- Tooltip Component
- Query Keys
- Routes README (file routing)

## God Nodes (most connected - your core abstractions)

1. `cn()` - 69 edges
2. `FileRoutesByPath` - 21 edges
3. `useAtlas` - 19 edges
4. `compilerOptions` - 17 edges
5. `PageHeader()` - 16 edges
6. `Atlas backend integration contract` - 15 edges
7. `scripts` - 13 edges
8. `CLAUDE.md — project architecture rules` - 12 edges
9. `Atlas limitations and backend backlog` - 11 edges
10. `Flow Designer documentation index` - 11 edges

## Surprising Connections (you probably didn't know these)

- `Atlas is the only authorization authority` --semantically_similar_to--> `Atlas is the source of truth (decision)` [INFERRED] [semantically similar]
  CLAUDE.md → docs/adr/0001-atlas-is-source-of-truth.md
- `createWorkflowSimulator()` --indirect_call--> `data()` [INFERRED]
  src/components/atlas/workflow-simulator.ts → tests/unit/auth-server.test.ts
- `CLAUDE.md — project architecture rules` --references--> `Lovable published-history policy` [INFERRED]
  CLAUDE.md → AGENTS.md
- `Delivery checklist` --references--> `Design tokens (src/styles.css)` [INFERRED]
  docs/CHECKLIST.md → CLAUDE.md
- `CalendarDayButton()` --references--> `react` [EXTRACTED]
  src/components/ui/calendar.tsx → package.json

## Import Cycles

- None detected.

## Hyperedges (group relationships)

- **flow-designer authentication and session flow** — docs_architecture_authentication_boundary, docs_architecture_atlas_bearer_token, docs_configuration_session_strategy, docs_frontend_engineering_csrf_middleware, docs_architecture_sse_transport [INFERRED 0.80]
- **Atlas-native workflow graph model** — docs_backend_integration_workflow_node_compatibility_matrix, docs_backend_integration_native_node_types, docs_backend_integration_workflow_definition_adapter, docs_atlas_limitations_no_layout_persistence [INFERRED 0.80]
- **Client/server transport and module boundary** — docs_frontend_engineering_server_function_boundary, docs_frontend_engineering_server_only_module, docs_frontend_engineering_import_boundary, docs_architecture_transport_layer [INFERRED 0.80]

## Communities (102 total, 56 thin omitted)

### Community 0 - "Atlas API & Auth Server"

Cohesion: 0.06
Nodes (59): AtlasCallOptions, AtlasError, atlasErrorKindForStatus(), atlasGetMe(), atlasLogin(), atlasLogout(), atlasRequest(), AtlasRequestOptions (+51 more)

### Community 1 - "Workflow Editor & Simulator"

Cohesion: 0.07
Nodes (44): configChoices(), configText(), DEFAULT_NODE_CONFIG, defaultedConfig(), nodeHint(), NodeInspector(), nodeTypes, RunLog (+36 more)

### Community 2 - "Architecture & Governance Docs"

Cohesion: 0.10
Nodes (46): AGENTS.md — Lovable sync policy, Lovable published-history policy, Atlas is the only authorization authority, Design tokens (src/styles.css), CLAUDE.md — project architecture rules, Atlas is the source of truth (decision), ADR-0001: Atlas is the source of truth, Atlas opaque bearer token (+38 more)

### Community 3 - "ESLint & Dev Dependencies"

Cohesion: 0.05
Nodes (39): eslint, eslint-config-prettier, @eslint/js, eslint-plugin-prettier, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, @lovable.dev/vite-tanstack-config (+31 more)

### Community 4 - "Router & Route Tree"

Cohesion: 0.06
Nodes (34): getRouter(), Route, Route, AppArtifactsRoute, AppAuditRoute, AppConversationsRoute, AppDashboardRoute, AppDeliveriesRoute (+26 more)

### Community 5 - "Atlas Error/Identity Mappers"

Cohesion: 0.12
Nodes (20): AtlasSidebar(), groups, AtlasErrorState(), LoadingState(), NotFoundState(), ClientAtlasError, describeAtlasError(), ErrorPresentation (+12 more)

### Community 6 - "TypeScript & Vite Config"

Cohesion: 0.07
Nodes (29): DOM, DOM.Iterable, ES2022, eslint.config.js, node, src/**/\*.ts, src/**/_.tsx, tests/\*\*/_.ts (+21 more)

### Community 7 - "Sidebar UI Component"

Cohesion: 0.07
Nodes (26): Sidebar, SidebarContent, SidebarContext, SidebarContextProps, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent (+18 more)

### Community 8 - "Overlay & Input Primitives"

Cohesion: 0.08
Nodes (15): Alert, AlertDescription, AlertTitle, alertVariants, Checkbox, HoverCardContent, PopoverContent, Progress (+7 more)

### Community 9 - "Button & Badge Primitives"

Cohesion: 0.16
Nodes (19): Badge(), BadgeProps, badgeVariants, Button, ButtonProps, buttonVariants, Calendar(), CalendarDayButton() (+11 more)

### Community 10 - "List/Table Route Pages"

Cohesion: 0.12
Nodes (11): DataTable(), PageHeader(), Route, rows, events, Route, rows, Route (+3 more)

### Community 11 - "Dashboard & Run/Workflow Pages"

Cohesion: 0.13
Nodes (16): StatusPill(), useAtlas, DashboardPage(), Route, FleetPage(), Route, Route, RunDetail() (+8 more)

### Community 12 - "shadcn Registry Config"

Cohesion: 0.11
Nodes (18): aliases, components, hooks, lib, ui, utils, iconLibrary, registries (+10 more)

### Community 13 - "Package Manifest & Scripts"

Cohesion: 0.11
Nodes (18): name, packageManager, private, scripts, build, build:dev, dev, format (+10 more)

### Community 14 - "Command & Dialog UI"

Cohesion: 0.12
Nodes (14): Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut() (+6 more)

### Community 15 - "Menubar UI Component"

Cohesion: 0.12
Nodes (11): Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarLabel, MenubarRadioItem, MenubarSeparator, MenubarShortcut() (+3 more)

### Community 16 - "Form UI Component"

Cohesion: 0.15
Nodes (11): FormControl, FormDescription, FormFieldContext, FormFieldContextValue, FormItem, FormItemContext, FormItemContextValue, FormLabel (+3 more)

### Community 17 - "SSR Server Entry & Errors"

Cohesion: 0.24
Nodes (9): consumeLastCapturedError(), renderErrorPage(), fetch(), getServerEntry(), isH3SwallowedErrorBody(), normalizeCatastrophicSsrResponse(), ServerEntry, csrfMiddleware (+1 more)

### Community 18 - "Runtime UI Dependencies"

Cohesion: 0.15
Nodes (13): cmdk, lucide-react, dependencies, cmdk, lucide-react, @radix-ui/react-checkbox, @radix-ui/react-progress, @radix-ui/react-slot (+5 more)

### Community 19 - "Carousel UI Component"

Cohesion: 0.15
Nodes (12): Carousel, CarouselApi, CarouselContent, CarouselContext, CarouselContextProps, CarouselItem, CarouselNext, CarouselOptions (+4 more)

### Community 20 - "Usage & Workspaces Pages"

Cohesion: 0.15
Nodes (10): Route, Route, bars, Route, workerUsage, Route, Row, WorkspacesPage() (+2 more)

### Community 21 - "Chart UI Component"

Cohesion: 0.20
Nodes (7): ChartConfig, ChartContainer, ChartContext, ChartContextProps, ChartLegendContent, ChartTooltipContent, THEMES

### Community 22 - "Context Menu UI"

Cohesion: 0.20
Nodes (9): ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuShortcut(), ContextMenuSubContent (+1 more)

### Community 23 - "Dropdown Menu UI"

Cohesion: 0.20
Nodes (9): DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut(), DropdownMenuSubContent (+1 more)

### Community 24 - "Root Shell & Lovable Reporting"

Cohesion: 0.24
Nodes (5): LovableErrorOptions, LovableEvents, reportLovableError(), Window, ErrorComponent()

### Community 25 - "Alert Dialog UI"

Cohesion: 0.22
Nodes (8): AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter(), AlertDialogHeader(), AlertDialogOverlay, AlertDialogTitle

### Community 26 - "Sheet UI Component"

Cohesion: 0.22
Nodes (8): SheetContent, SheetContentProps, SheetDescription, SheetFooter(), SheetHeader(), SheetOverlay, SheetTitle, sheetVariants

### Community 27 - "Table UI Component"

Cohesion: 0.22
Nodes (8): Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow

### Community 28 - "React UI Hooks"

Cohesion: 0.25
Nodes (7): react, react, useCarousel(), useChart(), useFormField(), useSidebar(), useIsMobile()

### Community 29 - "Breadcrumb UI Component"

Cohesion: 0.25
Nodes (7): Breadcrumb, BreadcrumbEllipsis(), BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator()

### Community 30 - "Drawer UI Component"

Cohesion: 0.25
Nodes (6): DrawerContent, DrawerDescription, DrawerFooter(), DrawerHeader(), DrawerOverlay, DrawerTitle

### Community 31 - "Navigation Menu UI"

Cohesion: 0.25
Nodes (7): NavigationMenu, NavigationMenuContent, NavigationMenuIndicator, NavigationMenuList, NavigationMenuTrigger, navigationMenuTriggerStyle, NavigationMenuViewport

### Community 32 - "Select UI Component"

Cohesion: 0.25
Nodes (7): SelectContent, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton, SelectSeparator, SelectTrigger

### Community 33 - "Card UI Component"

Cohesion: 0.29
Nodes (6): Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle

### Community 34 - "Toggle & Toggle Group"

Cohesion: 0.33
Nodes (5): ToggleGroup, ToggleGroupContext, ToggleGroupItem, Toggle, toggleVariants

### Community 35 - "Input OTP UI"

Cohesion: 0.40
Nodes (4): InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot

### Community 37 - "Users Route Page"

Cohesion: 0.40
Nodes (3): Route, tokens, users

### Community 38 - "Accordion UI Component"

Cohesion: 0.50
Nodes (3): AccordionContent, AccordionItem, AccordionTrigger

### Community 39 - "Avatar UI Component"

Cohesion: 0.50
Nodes (3): Avatar, AvatarFallback, AvatarImage

### Community 40 - "Tabs UI Component"

Cohesion: 0.50
Nodes (3): TabsContent, TabsList, TabsTrigger

## Knowledge Gaps

- **396 isolated node(s):** `$schema`, `style`, `rsc`, `tsx`, `css` (+391 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **56 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions

_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `Runtime UI Dependencies` to `Package Manifest & Scripts`, `React UI Hooks`, `class-variance-authority`, `clsx`, `date-fns`, `embla-carousel-react`, `@hookform/resolvers`, `input-otp`, `Radix Accordion`, `Radix Alert Dialog`, `Radix Aspect Ratio`, `Radix Avatar`, `Radix Collapsible`, `Radix Context Menu`, `Radix Dialog`, `Radix Dropdown Menu`, `Radix Hover Card`, `Radix Label`, `Radix Menubar`, `Radix Navigation Menu`, `Radix Popover`, `Radix Radio Group`, `Radix Scroll Area`, `Radix Select`, `Radix Separator`, `Radix Slider`, `Radix Switch`, `Radix Tabs`, `Radix Toggle`, `Radix Toggle Group`, `Radix Tooltip`, `react-day-picker`, `react-dom`, `react-hook-form`, `recharts`, `sonner`, `tailwind-merge`, `tailwindcss`, `@tailwindcss/vite`, `TanStack Query`, `TanStack Router`, `TanStack Start`, `TanStack Router Plugin`, `tw-animate-css`, `vaul`, `vite-tsconfig-paths`, `React Flow (@xyflow)`, `zod`, `zustand`?**
  _High betweenness centrality (0.160) - this node is a cross-community bridge._
- **Why does `cn()` connect `Button & Badge Primitives` to `Sidebar UI Component`, `Overlay & Input Primitives`, `Command & Dialog UI`, `Menubar UI Component`, `Form UI Component`, `Carousel UI Component`, `Chart UI Component`, `Context Menu UI`, `Dropdown Menu UI`, `Alert Dialog UI`, `Sheet UI Component`, `Table UI Component`, `Breadcrumb UI Component`, `Drawer UI Component`, `Navigation Menu UI`, `Select UI Component`, `Card UI Component`, `Toggle & Toggle Group`, `Input OTP UI`, `Accordion UI Component`, `Avatar UI Component`, `Tabs UI Component`, `Input Component`, `Separator Component`, `Skeleton Component`, `Tooltip Component`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **Why does `react` connect `React UI Hooks` to `Button & Badge Primitives`, `Runtime UI Dependencies`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **What connects `$schema`, `style`, `rsc` to the rest of the system?**
  _396 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Atlas API & Auth Server` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Workflow Editor & Simulator` be split into smaller, more focused modules?**
  _Cohesion score 0.06778476589797344 - nodes in this community are weakly interconnected._
- **Should `Architecture & Governance Docs` be split into smaller, more focused modules?**
  _Cohesion score 0.09565217391304348 - nodes in this community are weakly interconnected._

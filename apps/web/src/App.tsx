import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";

const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage").then((module) => ({ default: module.AnalyticsPage })));
const BrowserPage = lazy(() => import("./pages/BrowserPage").then((module) => ({ default: module.BrowserPage })));
const CodexPage = lazy(() => import("./pages/CodexPage").then((module) => ({ default: module.CodexPage })));
const ContentPage = lazy(() => import("./pages/ContentPage").then((module) => ({ default: module.ContentPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const InboxPage = lazy(() => import("./pages/InboxPage").then((module) => ({ default: module.InboxPage })));
const OperationsPage = lazy(() => import("./pages/OperationsPage").then((module) => ({ default: module.OperationsPage })));
const OrdersPage = lazy(() => import("./pages/OrdersPage").then((module) => ({ default: module.OrdersPage })));
const ProductsPage = lazy(() => import("./pages/ProductsPage").then((module) => ({ default: module.ProductsPage })));
const PublishPage = lazy(() => import("./pages/PublishPage").then((module) => ({ default: module.PublishPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

export function App() {
  return <Routes>
    <Route element={<AppShell />}>
      <Route index element={<DashboardPage />} />
      <Route path="products" element={<ProductsPage />} />
      <Route path="content/:productId?" element={<ContentPage />} />
      <Route path="publish" element={<PublishPage />} />
      <Route path="inbox" element={<InboxPage />} />
      <Route path="orders" element={<OrdersPage />} />
      <Route path="browser" element={<BrowserPage />} />
      <Route path="codex" element={<CodexPage />} />
      <Route path="analytics" element={<AnalyticsPage />} />
      <Route path="operations" element={<OperationsPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  </Routes>;
}

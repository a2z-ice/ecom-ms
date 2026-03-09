import React, { Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { setTokenProvider } from './api/client'
import NavBar from './components/NavBar'
import ErrorBoundary from './components/ErrorBoundary'
import ProtectedRoute from './components/ProtectedRoute'
import AdminRoute from './components/AdminRoute'
import CatalogPage from './pages/CatalogPage'
import SearchPage from './pages/SearchPage'
import CartPage from './pages/CartPage'
import CallbackPage from './pages/CallbackPage'
import LoginPage from './pages/LoginPage'
import OrderConfirmationPage from './pages/OrderConfirmationPage'
import NotFoundPage from './pages/NotFoundPage'

// Code-split admin pages — only loaded when an admin navigates to /admin/*
const AdminDashboard = React.lazy(() => import('./pages/admin/AdminDashboard'))
const AdminBooksPage = React.lazy(() => import('./pages/admin/AdminBooksPage'))
const AdminEditBookPage = React.lazy(() => import('./pages/admin/AdminEditBookPage'))
const AdminStockPage = React.lazy(() => import('./pages/admin/AdminStockPage'))
const AdminOrdersPage = React.lazy(() => import('./pages/admin/AdminOrdersPage'))

function AppWithAuth() {
  const { getAccessToken } = useAuth()
  // Wire the in-memory token into the API client once
  setTokenProvider(getAccessToken)

  return (
    <BrowserRouter>
      <NavBar />
      <ErrorBoundary>
        <Suspense fallback={<div className="loading-state">Loading...</div>}>
          <Routes>
            <Route path="/" element={<CatalogPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/callback" element={<CallbackPage />} />
            <Route path="/order-confirmation" element={
              <ProtectedRoute><OrderConfirmationPage /></ProtectedRoute>
            } />
            {/* Admin routes — require admin Keycloak realm role */}
            <Route path="/admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
            <Route path="/admin/books" element={<AdminRoute><AdminBooksPage /></AdminRoute>} />
            <Route path="/admin/books/new" element={<AdminRoute><AdminEditBookPage /></AdminRoute>} />
            <Route path="/admin/books/:id" element={<AdminRoute><AdminEditBookPage /></AdminRoute>} />
            <Route path="/admin/stock" element={<AdminRoute><AdminStockPage /></AdminRoute>} />
            <Route path="/admin/orders" element={<AdminRoute><AdminOrdersPage /></AdminRoute>} />
            {/* 404 catch-all */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppWithAuth />
    </AuthProvider>
  )
}

import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { setTokenProvider } from './api/client'
import NavBar from './components/NavBar'
import ProtectedRoute from './components/ProtectedRoute'
import AdminRoute from './components/AdminRoute'
import CatalogPage from './pages/CatalogPage'
import SearchPage from './pages/SearchPage'
import CartPage from './pages/CartPage'
import CallbackPage from './pages/CallbackPage'
import LoginPage from './pages/LoginPage'
import OrderConfirmationPage from './pages/OrderConfirmationPage'
import AdminDashboard from './pages/admin/AdminDashboard'
import AdminBooksPage from './pages/admin/AdminBooksPage'
import AdminEditBookPage from './pages/admin/AdminEditBookPage'
import AdminStockPage from './pages/admin/AdminStockPage'
import AdminOrdersPage from './pages/admin/AdminOrdersPage'

function AppWithAuth() {
  const { getAccessToken } = useAuth()
  // Wire the in-memory token into the API client once
  setTokenProvider(getAccessToken)

  return (
    <BrowserRouter>
      <NavBar />
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
      </Routes>
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

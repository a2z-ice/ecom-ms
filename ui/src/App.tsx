import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { setTokenProvider } from './api/client'
import NavBar from './components/NavBar'
import ProtectedRoute from './components/ProtectedRoute'
import CatalogPage from './pages/CatalogPage'
import SearchPage from './pages/SearchPage'
import CartPage from './pages/CartPage'
import CallbackPage from './pages/CallbackPage'
import LoginPage from './pages/LoginPage'
import OrderConfirmationPage from './pages/OrderConfirmationPage'

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

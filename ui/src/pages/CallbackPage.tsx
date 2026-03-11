import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { userManager } from '../auth/oidcConfig'
import { getGuestCart, clearGuestCart } from '../hooks/useGuestCart'

export default function CallbackPage() {
  const navigate = useNavigate()

  useEffect(() => {
    userManager.signinRedirectCallback()
      .then(async (user) => {
        const state = user.state as { returnUrl?: string } | undefined
        const returnUrl = state?.returnUrl || '/'

        // Merge guest cart items to server cart if any exist
        const pending = getGuestCart()
        if (pending.length > 0) {
          await Promise.allSettled(
            pending.map(item =>
              fetch('/ecom/cart', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${user.access_token}`,
                },
                body: JSON.stringify({ bookId: item.bookId, quantity: item.quantity }),
              })
            )
          )
          clearGuestCart()
        }

        // Cross-origin return (e.g. http://myecom.net:30000/): relay the auth token via
        // URL hash so the destination origin can restore the session. The hash is not
        // sent to servers and is cleared immediately by AuthContext on arrival.
        const isAbsolute = returnUrl.startsWith('http://') || returnUrl.startsWith('https://')
        if (isAbsolute) {
          const relay = encodeURIComponent(user.toStorageString())
          window.location.href = `${returnUrl}#auth=${relay}`
        } else if (pending.length > 0 && returnUrl === '/') {
          navigate('/cart')
        } else {
          navigate(returnUrl)
        }
      })
      .catch(err => {
        console.error('OIDC callback error:', err)
        navigate('/')
      })
  }, [navigate])

  return <div className="loading-state">Completing login...</div>
}

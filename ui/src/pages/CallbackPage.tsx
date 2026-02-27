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

        const pending = getGuestCart()
        if (pending.length > 0) {
          // Sync each guest cart item to the server using the fresh access token
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
          // If a specific page was stored, go there; otherwise go to /cart
          navigate(returnUrl !== '/' ? returnUrl : '/cart')
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

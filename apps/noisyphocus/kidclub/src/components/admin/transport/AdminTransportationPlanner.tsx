import { useState, useEffect } from 'react';
import { GoogleMap, LoadScript, DirectionsRenderer, Marker } from '@react-google-maps/api';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import { TransportationSubscription } from '@shared/models/Transportation';

// Define the structure for waypoints with status
interface CustomWaypoint {
    location: { latLng: { latitude: number; longitude: number; }, address: string };
    status: 'confirmed' | 'pending';
}

// Define the structure for the Google Routes API request
interface ComputeRoutesRequest {
  origin: { location: { latLng: { latitude: number; longitude: number; } } };
  destination: { location: { latLng: { latitude: number; longitude: number; } } };
  intermediates: { location: { latLng: { latitude: number; longitude: number; } } }[];
  travelMode: string;
  optimizeWaypointOrder: boolean;
}

const AdminTransportationPlanner = () => {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [route, setRoute] = useState<google.maps.DirectionsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderedWaypoints, setOrderedWaypoints] = useState<CustomWaypoint[]>([]);

  const schoolAddress = 'R. do Arco-Íris 123, 1234-567 Lisboa'; // Replace with actual school address

  const handlePlanRoute = async () => {
    setLoading(true);
    setError(null);
    setRoute(null);
    setOrderedWaypoints([]);

    try {
      const allWaypoints = await fetchWaypointsForDate(selectedDate);
      const combinedWaypoints = [...allWaypoints.confirmed, ...allWaypoints.pending];

      if (combinedWaypoints.length === 0) {
        setError('No pickups (confirmed or pending) scheduled for this date.');
        setLoading(false);
        return;
      }

      const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
      const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';

      const requestBody: ComputeRoutesRequest = {
        origin: { location: { latLng: { latitude: 38.7223, longitude: -9.1393 } } }, // TODO: Replace with actual school lat/lng
        destination: { location: { latLng: { latitude: 38.7223, longitude: -9.1393 } } }, // TODO: Replace with actual school lat/lng
        intermediates: combinedWaypoints.map(wp => ({ location: { latLng: wp.location.latLng }})),
        travelMode: 'DRIVE',
        optimizeWaypointOrder: true,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.optimizedIntermediateWaypointIndex,routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.duration,routes.legs.distanceMeters,routes.legs.startLocation,routes.legs.endLocation',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error.message || 'Failed to fetch route.');
      }

      const result = await response.json();
      
      if (result.routes && result.routes.length > 0) {
        const googleRoute = result.routes[0];
        
        // Reorder our original waypoints based on the optimized index from the API
        const finalOrderedWaypoints = googleRoute.optimizedIntermediateWaypointIndex.map((index: number) => combinedWaypoints[index]);
        setOrderedWaypoints(finalOrderedWaypoints);

        // Create a DirectionsResult object for rendering the polyline
        const directionsResult = mapRoutesApiResponseToDirectionsResult(googleRoute, requestBody);
        setRoute(directionsResult);

      } else {
        setError('Could not find a route.');
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const fetchWaypointsForDate = async (date: string): Promise<{ confirmed: CustomWaypoint[], pending: CustomWaypoint[] }> => {
    const confirmed: CustomWaypoint[] = [];
    const pending: CustomWaypoint[] = [];
    const dayOfWeek = new Date(date).toLocaleString('en-US', { weekday: 'long' }).toLowerCase();

    // Fetch subscriptions (always considered confirmed for planning)
    const subsQuery = query(collection(db, 'transportationSubscriptions'), where('status', '==', 'active'));
    const subsSnapshot = await getDocs(subsQuery);
    subsSnapshot.forEach(doc => {
      const sub = doc.data() as TransportationSubscription;
      if (new Date(sub.startDate) <= new Date(date)) {
        sub.schedule.forEach(item => {
          if (item.dayOfWeek.toLowerCase() === dayOfWeek) {
            // TODO: Geocode the address from the subscription
            console.warn('Subscription pickup location is a string and needs to be geocoded:', item.pickupLocation);
            // confirmed.push({ location: { address: item.pickupLocation.address }, status: 'confirmed' });
          }
        });
      }
    });

    return { confirmed, pending };
  };

  const mapRoutesApiResponseToDirectionsResult = (route: any, request: ComputeRoutesRequest): google.maps.DirectionsResult => {
    return {
      request: {
        origin: { lat: request.origin.location.latLng.latitude, lng: request.origin.location.latLng.longitude },
        destination: { lat: request.destination.location.latLng.latitude, lng: request.destination.location.latLng.longitude },
        travelMode: google.maps.TravelMode.DRIVING,
        waypoints: request.intermediates.map(intermediate => ({
          location: { lat: intermediate.location.latLng.latitude, lng: intermediate.location.latLng.longitude },
          stopover: true,
        })).filter(Boolean),
        optimizeWaypoints: request.optimizeWaypointOrder,
      },
      routes: [{
        overview_polyline: { points: route.polyline.encodedPolyline },
        bounds: new google.maps.LatLngBounds(),
        legs: route.legs.map((leg: any) => ({
            duration: { text: leg.duration, value: parseInt(leg.duration) },
            distance: { text: `${(leg.distanceMeters / 1000).toFixed(2)} km`, value: leg.distanceMeters },
            start_location: new google.maps.LatLng(leg.startLocation.latLng.latitude, leg.startLocation.latLng.longitude),
            end_location: new google.maps.LatLng(leg.endLocation.latLng.latitude, leg.endLocation.latLng.longitude),
        })),
        summary: '',
        copyrights: '',
        warnings: [],
        waypoint_order: route.optimizedIntermediateWaypointIndex,
      }],
    } as unknown as google.maps.DirectionsResult;
  };

  const getMarkerIcon = (status: 'confirmed' | 'pending') => ({
    path: google.maps.SymbolPath.CIRCLE,
    scale: 8,
    fillColor: status === 'pending' ? '#f0ad4e' : '#5cb85c', // Yellow for pending, Green for confirmed
    fillOpacity: 1,
    strokeWeight: 1,
    strokeColor: '#fff',
  });

  return (
    <div className="p-4 bg-white rounded-lg shadow">
      <h2 className="text-xl font-bold mb-4">Planeamento de Rota Diária</h2>
      <div className="flex items-center space-x-4 mb-4">
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="p-2 border rounded"
        />
        <button
          onClick={handlePlanRoute}
          disabled={loading}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-blue-300"
        >
          {loading ? 'Planeando...' : 'Planear Rota'}
        </button>
      </div>

      {error && <div className="text-red-500 bg-red-100 p-3 rounded mb-4">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2" style={{ height: '600px' }}>
          <LoadScript googleMapsApiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY} libraries={['places']}>
            <GoogleMap
              mapContainerStyle={{ width: '100%', height: '100%' }}
              center={{ lat: 40.2056, lng: -8.4196 }} // Center on Coimbra
              zoom={12}
            >
              {route && <DirectionsRenderer options={{ directions: route, suppressMarkers: true, polylineOptions: { strokeColor: '#4A90E2', strokeWeight: 5 } }} />}
              {orderedWaypoints.filter(Boolean).map((waypoint, index) => (
                <Marker 
                    key={index} 
                    position={route?.routes[0]?.legs[index]?.start_location as google.maps.LatLng} 
                    label={{ text: `${index + 1}`, color: 'white' }} 
                    icon={getMarkerIcon(waypoint.status)}
                />
              ))}
            </GoogleMap>
          </LoadScript>
        </div>
        <div>
          <h3 className="font-bold mb-2">Ordem de Recolha Otimizada</h3>
          {orderedWaypoints.length > 0 ? (
            <ol className="space-y-2">
              {orderedWaypoints.filter(Boolean).map((waypoint, index) => (
                <li key={index} className="flex items-center p-2 rounded-md" style={{ borderLeft: `5px solid ${waypoint.status === 'pending' ? '#f0ad4e' : '#5cb85c'}`}}>
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-700 text-white text-xs font-bold mr-3">{index + 1}</span>
                    <span>{waypoint.location.address}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-gray-500">A ordem das paragens aparecerá aqui.</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminTransportationPlanner;